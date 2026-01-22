const MENU_ID = "chatgpt-dom-cleaner:clean";
const KEEP_LAST_DEFAULT = 4;
const STORAGE_KEY_KEEP_LAST = "keepLast";
const STORAGE_KEY_LANG_OVERRIDE = "langOverride"; // "auto" | "en" | "ru"

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

async function syncLangOverrideFromStorage() {
  try {
    const raw = await chrome.storage.sync.get([STORAGE_KEY_LANG_OVERRIDE]);
    langOverride = normalizeLangOverride(raw?.[STORAGE_KEY_LANG_OVERRIDE]);
    localeMessages = await loadLocaleMessages(langOverride);
  } catch {
    langOverride = "auto";
    localeMessages = null;
  }
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    void (async () => {
      await syncLangOverrideFromStorage();
      chrome.contextMenus.create({
        id: MENU_ID,
        title: t("contextMenuTitle", [String(KEEP_LAST_DEFAULT)]) ||
          `Clean chat DOM nodes (keep ${KEEP_LAST_DEFAULT})`,
        contexts: ["page", "action"],
        documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
      });

      // Best-effort: pull the value from storage and update the label.
      void syncContextMenuTitleFromStorage();
    })();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id) return;
  (async () => {
    const keepLast = await getKeepLastFromStorage();
    await runCleanupOnTab(tab.id, keepLast);
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "GET_LOCALE_MESSAGES") {
    (async () => {
      try {
        const locale = normalizeLangOverride(msg.locale);
        const messages = await loadLocaleMessages(locale);
        sendResponse({ ok: true, locale, messages });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return true;
  }

  if (msg.type !== "CLEAN_CHAT_DOM") return;

  (async () => {
    try {
      const keepLast = Number.isFinite(msg.keepLast)
        ? msg.keepLast
        : await getKeepLastFromStorage();
      const tabId = await getActiveTabId();
      const result = await runCleanupOnTab(tabId, keepLast);
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  })();

  return true; // keep sendResponse alive for async
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  const keepChanged = Boolean(changes?.[STORAGE_KEY_KEEP_LAST]);
  const langChanged = Boolean(changes?.[STORAGE_KEY_LANG_OVERRIDE]);
  if (!keepChanged && !langChanged) return;

  void (async () => {
    if (langChanged) await syncLangOverrideFromStorage();
    await syncContextMenuTitleFromStorage();
  })();
});

/**
 * Reads `keepLast` from `chrome.storage.sync` and normalizes it.
 *
 * @returns {Promise<number>}
 */
async function getKeepLastFromStorage() {
  const raw = await chrome.storage.sync.get([STORAGE_KEY_KEEP_LAST]);
  return sanitizeKeepLast(raw?.[STORAGE_KEY_KEEP_LAST]);
}

/**
 * Updates the context menu item's title based on the current `keepLast`.
 *
 * @returns {Promise<void>}
 */
async function syncContextMenuTitleFromStorage() {
  try {
    const keepLast = await getKeepLastFromStorage();
    chrome.contextMenus.update(MENU_ID, {
      title: t("contextMenuTitle", [String(keepLast)]) || `Clean chat DOM nodes (keep ${keepLast})`
    });
  } catch {
    // ignore
  }
}

/**
 * Normalizes `keepLast`: finite number, integer, range [1..99].
 *
 * @param {unknown} v
 * @returns {number}
 */
function sanitizeKeepLast(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return KEEP_LAST_DEFAULT;
  return Math.min(99, Math.max(1, Math.floor(n)));
}

/**
 * Returns the `tabId` of the active tab in the current window.
 *
 * Used by the service worker when the popup sends a cleanup command.
 *
 * @returns {Promise<number>} Active tab ID.
 * @throws {Error} If the active tab cannot be determined (no `tab.id`).
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error(t("errNoActiveTab") || "Couldn't find the active tab.");
  return tab.id;
}

/**
 * Runs DOM cleanup on a tab via `chrome.scripting.executeScript`.
 *
 * Important: injection runs in the page context. `cleanChatDom` must be self-contained
 * (no closures over service-worker variables).
 *
 * @param {number} tabId - Target tab ID.
 * @param {number} keepLast - How many last messages to keep (floored, min 0).
 * @returns {Promise<{total:number, removed:number, kept:number}>} Cleanup result.
 * @throws {Error} If `executeScript` returns no result.
 */
async function runCleanupOnTab(tabId, keepLast) {
  const keep = Math.max(0, Math.floor(keepLast));

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: cleanChatDom,
    args: [keep]
  });

  if (!Array.isArray(injected) || injected.length === 0) {
    throw new Error(t("errExecuteScriptNoResult") || "executeScript returned no result.");
  }

  return injected[0].result;
}

/**
 * Cleans the current ChatGPT conversation DOM: removes old message nodes (`article`),
 * keeping the last `keepLast`.
 *
 * Scope is limited to `main` to avoid removing `article` elements in other parts of the page.
 *
 * @param {number} keepLast - How many last messages to keep.
 * @returns {{total:number, removed:number, kept:number}} Counters before/after.
 */
function cleanChatDom(keepLast) {
  const keep = Math.max(0, Math.floor(Number(keepLast)));
  /** IndexedDB database name. */
  const IDB_NAME = "chatgpt-dom-cleaner";
  /** IndexedDB version (for schema migrations). */
  const IDB_VERSION = 2;
  /** IndexedDB objectStore name. */
  const IDB_STORE = "removedMessages";
  /** Per-conversation removed-messages history limit (by number of records). */
  const MAX_REMOVED_CACHE = 500;

  const root = document.querySelector("main") ?? document.body;

  const primary = Array.from(
    root.querySelectorAll('article[data-testid^="conversation-turn"]')
  );

  // Fallback for markup changes. Keep the scope inside `main` to avoid wiping the whole page.
  const nodes = primary.length ? primary : Array.from(root.querySelectorAll("article"));

  const total = nodes.length;
  if (total <= keep) {
    return { total, removed: 0, kept: total };
  }

  const toRemove = nodes.slice(0, total - keep);
  const removedHtml = toRemove.map((el) => el.outerHTML);
  for (const el of toRemove) el.remove();

  // Persist removed messages in IndexedDB (page context).
  /**
   * Opens IndexedDB and ensures required indexes exist.
   *
   * @returns {Promise<IDBDatabase>}
   */
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let store;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        store = db.createObjectStore(IDB_STORE, {
          keyPath: "id",
          autoIncrement: true
        });
      } else {
        store = request.transaction.objectStore(IDB_STORE);
      }

      if (!store.indexNames.contains("conversationKey")) {
        store.createIndex("conversationKey", "conversationKey", { unique: false });
      }
      if (!store.indexNames.contains("conversationKey_createdAt")) {
        store.createIndex(
          "conversationKey_createdAt",
          ["conversationKey", "createdAt"],
          { unique: false }
        );
      }
      if (!store.indexNames.contains("conversationKey_id")) {
        store.createIndex(
          "conversationKey_id",
          ["conversationKey", "id"],
          { unique: false }
        );
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IDB open failed"));
  });

  /**
   * Trims per-conversation history down to MAX_REMOVED_CACHE.
   *
   * @param {IDBDatabase} db
   * @param {string} conversationKey
   * @returns {Promise<void>}
   */
  const pruneConversation = (db, conversationKey) => {
    if (!Number.isFinite(MAX_REMOVED_CACHE)) return Promise.resolve();
    return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const index = store.index("conversationKey_createdAt");
    const range = IDBKeyRange.bound(
      [conversationKey, 0],
      [conversationKey, Number.MAX_SAFE_INTEGER]
    );
    const keys = [];

    index.openCursor(range, "next").onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        keys.push(cursor.primaryKey);
        cursor.continue();
        return;
      }

      const excess = keys.length - MAX_REMOVED_CACHE;
      if (excess > 0) {
        for (let i = 0; i < excess; i += 1) {
          store.delete(keys[i]);
        }
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IDB prune failed"));
  });
  };

  /**
   * Appends a batch of removed messages to IndexedDB.
   *
   * @param {string[]} htmlList
   * @returns {Promise<void>}
   */
  const appendRemovedMessages = async (htmlList) => {
    if (!htmlList.length) return;
    const db = await openDb();
    const conversationKey = `${location.pathname}`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const now = Date.now();
      let i = 0;
      for (const html of htmlList) {
        store.add({
          conversationKey,
          html,
          createdAt: now + i / 1000
        });
        i += 1;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IDB add failed"));
    });
    await pruneConversation(db, conversationKey);
  };

  void appendRemovedMessages(removedHtml);

  return { total, removed: toRemove.length, kept: keep };
}

