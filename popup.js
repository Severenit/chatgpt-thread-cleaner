const DEFAULT_KEEP_LAST = 4;
const STORAGE_KEY_KEEP_LAST = "keepLast";
const STORAGE_KEY_LANG_OVERRIDE = "langOverride"; // "auto" | "en" | "ru"

const cleanBtn = document.getElementById("clean");
const statusEl = document.getElementById("status");
const keepLastInput = document.getElementById("keepLast");
const langSelect = document.getElementById("lang");

/** @type {null | "auto" | "en" | "ru"} */
let langOverride = null;
/** @type {Record<string, any> | null} */
let localeMessages = null;

const LOCALE_CACHE = new Map(); // locale -> messages.json object

function normalizeLangOverride(v) {
  if (v === "en" || v === "ru" || v === "auto") return v;
  return "auto";
}

function normalizeSubstitutions(substitutions) {
  if (substitutions == null) return [];
  if (Array.isArray(substitutions)) return substitutions.map(String);
  return [String(substitutions)];
}

function formatFromLocaleEntry(entry, substitutions) {
  if (!entry?.message) return "";
  const subs = normalizeSubstitutions(substitutions);
  if (!entry.placeholders) return String(entry.message);

  const byName = {};
  for (const [name, def] of Object.entries(entry.placeholders)) {
    const content = String(def?.content || "");
    // Chrome i18n placeholder "content" is typically "$1" (no trailing $).
    const m = content.match(/^\$(\d+)\$?$/);
    const idx = m ? Number(m[1]) - 1 : -1;
    byName[name] = idx >= 0 ? String(subs[idx] ?? "") : "";
  }

  return String(entry.message).replace(/\$([a-zA-Z0-9_]+)\$/g, (_m, name) =>
    Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : ""
  );
}

async function loadLocaleMessages(locale) {
  if (!locale || locale === "auto") return null;
  if (LOCALE_CACHE.has(locale)) return LOCALE_CACHE.get(locale);
  const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load locale ${locale}`);
  const json = await res.json();
  LOCALE_CACHE.set(locale, json);
  return json;
}

function t(messageName, substitutions) {
  if (langOverride && langOverride !== "auto" && localeMessages) {
    const entry = localeMessages[messageName];
    const formatted = formatFromLocaleEntry(entry, substitutions);
    if (formatted) return formatted;
  }

  try {
    const msg = chrome?.i18n?.getMessage?.(messageName, substitutions);
    return msg || "";
  } catch {
    return "";
  }
}

async function applyI18nToDom() {
  const raw = await chrome.storage.sync.get([STORAGE_KEY_LANG_OVERRIDE]);
  langOverride = normalizeLangOverride(raw?.[STORAGE_KEY_LANG_OVERRIDE]);
  localeMessages = await loadLocaleMessages(langOverride);

  const effectiveLang =
    langOverride && langOverride !== "auto"
      ? langOverride
      : chrome?.i18n?.getUILanguage?.() || "en";

  document.documentElement.lang = effectiveLang;
  document.title = t("popupTitle") || document.title;

  const nodes = document.querySelectorAll("[data-i18n]");
  for (const el of nodes) {
    const key = el.getAttribute("data-i18n");
    if (!key) continue;
    const msg = t(key);
    if (msg) el.textContent = msg;
  }
}

/**
 * Updates the status text in the popup.
 *
 * @param {string} text - The text shown to the user.
 */
function setStatus(text) {
  statusEl.textContent = text;
}

// Best-effort: inherit typography from the active ChatGPT tab so the popup looks native.
applyFontFromActiveTab().catch(() => {});

void (async () => {
  await applyI18nToDom();
  await initSettings();
})().catch(() => {});

cleanBtn.addEventListener("click", async () => {
  cleanBtn.disabled = true;
  setStatus(t("statusCleaning") || "...");

  try {
    const keepLast = await getKeepLast();
    const res = await chrome.runtime.sendMessage({
      type: "CLEAN_CHAT_DOM",
      keepLast
    });

    if (!res?.ok) {
      throw new Error(res?.error || t("statusUnknownError") || "Unknown error.");
    }

    const { total, removed, kept } = res.result || {};
    setStatus(
      t("statusRemovedSummary", [String(removed ?? "?"), String(total ?? "?"), String(kept ?? "?")]) ||
        ""
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(t("statusErrorPrefix", [msg]) || msg);
  } finally {
    cleanBtn.disabled = false;
  }
});

/**
 * Initializes the `keepLast` UI setting:
 * - reads from storage (or uses the default)
 * - updates the input and the button label
 * - persists changes on input change
 *
 * @returns {Promise<void>}
 */
async function initSettings() {
  // Language override
  try {
    const raw = await chrome.storage.sync.get([STORAGE_KEY_LANG_OVERRIDE]);
    const v = normalizeLangOverride(raw?.[STORAGE_KEY_LANG_OVERRIDE]);
    langSelect.value = v;
  } catch {
    langSelect.value = "auto";
  }

  langSelect.addEventListener("change", async () => {
    const next = normalizeLangOverride(langSelect.value);
    await chrome.storage.sync.set({ [STORAGE_KEY_LANG_OVERRIDE]: next });
    // Re-apply i18n and refresh labels.
    await applyI18nToDom();
    const keepLast = sanitizeKeepLast(keepLastInput.value);
    updateCleanButtonLabel(keepLast);
    setStatus("");
  });

  const keepLast = await getKeepLast();
  keepLastInput.value = String(keepLast);
  updateCleanButtonLabel(keepLast);

  keepLastInput.addEventListener("change", async () => {
    const next = sanitizeKeepLast(keepLastInput.value);
    keepLastInput.value = String(next);
    await setKeepLast(next);
    updateCleanButtonLabel(next);
    setStatus("");
  });

  keepLastInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    keepLastInput.blur();
  });
}

/**
 * Updates the popup action button label.
 *
 * @param {number} keepLast
 */
function updateCleanButtonLabel(keepLast) {
  cleanBtn.textContent = t("cleanButtonWithKeep", [String(keepLast)]) || cleanBtn.textContent;
}

/**
 * Reads `keepLast` from `chrome.storage.sync`.
 *
 * @returns {Promise<number>}
 */
async function getKeepLast() {
  const raw = await chrome.storage.sync.get([STORAGE_KEY_KEEP_LAST]);
  return sanitizeKeepLast(raw?.[STORAGE_KEY_KEEP_LAST]);
}

/**
 * Writes `keepLast` to `chrome.storage.sync`.
 *
 * @param {number} keepLast
 * @returns {Promise<void>}
 */
async function setKeepLast(keepLast) {
  await chrome.storage.sync.set({ [STORAGE_KEY_KEEP_LAST]: sanitizeKeepLast(keepLast) });
}

/**
 * Normalizes user input.
 *
 * @param {unknown} v
 * @returns {number}
 */
function sanitizeKeepLast(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_KEEP_LAST;
  return Math.min(99, Math.max(1, Math.floor(n)));
}

/**
 * Best-effort: fetches typography (font-*) from the active tab and applies it to the popup via
 * CSS variables (`--chatgpt-*`).
 *
 * This makes the popup visually blend with the current ChatGPT theme/fonts.
 *
 * Limitations:
 * - Works only if the active tab allows `executeScript` (for us: `chatgpt.com` / `chat.openai.com`).
 * - If injection is not possible/allowed, the function fails silently.
 *
 * @returns {Promise<void>}
 */
async function applyFontFromActiveTab() {
  if (!chrome?.tabs?.query || !chrome?.scripting?.executeScript) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const el = document.body || document.documentElement;
      const s = getComputedStyle(el);
      return {
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        fontFeatureSettings: s.fontFeatureSettings,
        fontVariationSettings: s.fontVariationSettings
      };
    }
  });

  const res = injected?.[0]?.result;
  if (!res) return;

  const root = document.documentElement;
  if (res.fontFamily) root.style.setProperty("--chatgpt-font-family", res.fontFamily);
  if (res.fontSize) root.style.setProperty("--chatgpt-font-size", res.fontSize);
  if (res.lineHeight) root.style.setProperty("--chatgpt-line-height", res.lineHeight);
  if (res.fontFeatureSettings)
    root.style.setProperty("--chatgpt-font-feature-settings", res.fontFeatureSettings);
  if (res.fontVariationSettings)
    root.style.setProperty("--chatgpt-font-variation-settings", res.fontVariationSettings);
}
