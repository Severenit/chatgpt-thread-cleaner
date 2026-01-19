const MENU_ID = "chatgpt-dom-cleaner:clean";
const KEEP_LAST_DEFAULT = 4;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Очистить DOM узлы в чате (оставить 4)",
      contexts: ["page", "action"],
      documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id) return;
  runCleanupOnTab(tab.id, KEEP_LAST_DEFAULT);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CLEAN_CHAT_DOM") return;

  (async () => {
    try {
      const keepLast = Number.isFinite(msg.keepLast) ? msg.keepLast : KEEP_LAST_DEFAULT;
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

/**
 * Возвращает `tabId` активной вкладки в текущем окне.
 *
 * Используется сервис-воркером, когда popup отправляет команду очистки.
 *
 * @returns {Promise<number>} ID активной вкладки.
 * @throws {Error} Если активную вкладку определить не удалось (нет `tab.id`).
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Не нашёл активную вкладку.");
  return tab.id;
}

/**
 * Запускает очистку DOM на вкладке через `chrome.scripting.executeScript`.
 *
 * Важно: инжект происходит в контекст страницы. Функция `cleanChatDom` должна быть
 * самодостаточной (без замыканий на переменные service worker).
 *
 * @param {number} tabId - ID вкладки, на которой выполняем очистку.
 * @param {number} keepLast - Сколько последних сообщений оставить (округляется вниз, минимум 0).
 * @returns {Promise<{total:number, removed:number, kept:number}>} Результат очистки.
 * @throws {Error} Если `executeScript` не вернул результат.
 */
async function runCleanupOnTab(tabId, keepLast) {
  const keep = Math.max(0, Math.floor(keepLast));

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: cleanChatDom,
    args: [keep]
  });

  if (!Array.isArray(injected) || injected.length === 0) {
    throw new Error("executeScript не вернул результат.");
  }

  return injected[0].result;
}

/**
 * Чистит DOM текущего диалога ChatGPT: удаляет старые узлы сообщений (`article`),
 * оставляя последние `keepLast`.
 *
 * Скоуп ограничен `main`, чтобы не удалять `article` в других частях страницы.
 *
 * @param {number} keepLast - Сколько последних сообщений оставить.
 * @returns {{total:number, removed:number, kept:number}} Счётчики до/после.
 */
function cleanChatDom(keepLast) {
  const keep = Math.max(0, Math.floor(Number(keepLast)));

  const root = document.querySelector("main") ?? document.body;

  const primary = Array.from(
    root.querySelectorAll('article[data-testid^="conversation-turn"]')
  );

  // Fallback на случай изменений разметки. Держим скоуп внутри main, чтобы не снести всё на странице.
  const nodes = primary.length ? primary : Array.from(root.querySelectorAll("article"));

  const total = nodes.length;
  if (total <= keep) {
    return { total, removed: 0, kept: total };
  }

  const toRemove = nodes.slice(0, total - keep);
  for (const el of toRemove) el.remove();

  return { total, removed: toRemove.length, kept: keep };
}

