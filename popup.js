const KEEP_LAST = 3;

const cleanBtn = document.getElementById("clean");
const statusEl = document.getElementById("status");

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

cleanBtn.addEventListener("click", async () => {
  cleanBtn.disabled = true;
  setStatus("Чищу...");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "CLEAN_CHAT_DOM",
      keepLast: KEEP_LAST
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
