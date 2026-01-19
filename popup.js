const DEFAULT_KEEP_LAST = 4;
const STORAGE_KEY_KEEP_LAST = "keepLast";

const cleanBtn = document.getElementById("clean");
const statusEl = document.getElementById("status");
const keepLastInput = document.getElementById("keepLast");

/**
 * Обновляет текст статуса в popup.
 *
 * @param {string} text - Текст, который покажем пользователю.
 */
function setStatus(text) {
  statusEl.textContent = text;
}

// Best-effort: подтянуть typographic settings из активной вкладки ChatGPT, чтобы popup выглядел нативно.
applyFontFromActiveTab().catch(() => {});

initSettings().catch(() => {});

cleanBtn.addEventListener("click", async () => {
  cleanBtn.disabled = true;
  setStatus("Чищу...");

  try {
    const keepLast = await getKeepLast();
    const res = await chrome.runtime.sendMessage({
      type: "CLEAN_CHAT_DOM",
      keepLast
    });

    if (!res?.ok) {
      throw new Error(res?.error || "Неизвестная ошибка.");
    }

    const { total, removed, kept } = res.result || {};
    setStatus(`Удалено ${removed ?? "?"} из ${total ?? "?"}. Оставлено ${kept ?? "?"}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Ошибка: ${msg}`);
  } finally {
    cleanBtn.disabled = false;
  }
});

/**
 * Инициализирует UI-настройку keepLast:
 * - читает значение из storage (или берёт default)
 * - обновляет input и подпись кнопки
 * - сохраняет изменения по input
 *
 * @returns {Promise<void>}
 */
async function initSettings() {
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
 * Обновляет текст кнопки запуска в popup.
 *
 * @param {number} keepLast
 */
function updateCleanButtonLabel(keepLast) {
  cleanBtn.textContent = `Очистить DOM (оставить ${keepLast})`;
}

/**
 * Читает keepLast из `chrome.storage.sync`.
 *
 * @returns {Promise<number>}
 */
async function getKeepLast() {
  const raw = await chrome.storage.sync.get([STORAGE_KEY_KEEP_LAST]);
  return sanitizeKeepLast(raw?.[STORAGE_KEY_KEEP_LAST]);
}

/**
 * Записывает keepLast в `chrome.storage.sync`.
 *
 * @param {number} keepLast
 * @returns {Promise<void>}
 */
async function setKeepLast(keepLast) {
  await chrome.storage.sync.set({ [STORAGE_KEY_KEEP_LAST]: sanitizeKeepLast(keepLast) });
}

/**
 * Нормализует ввод пользователя.
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
 * Best-effort: подтягивает типографику (font-*) со страницы активной вкладки и
 * применяет её к popup через CSS variables (`--chatgpt-*`).
 *
 * Это нужно, чтобы popup визуально “сливался” с текущей темой/шрифтами ChatGPT.
 *
 * Ограничения:
 * - Сработает только если активная вкладка позволяет `executeScript`
 *   (в нашем случае — на `chatgpt.com` / `chat.openai.com`).
 * - Если инжект невозможен/запрещён, функция просто молча завершается.
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
