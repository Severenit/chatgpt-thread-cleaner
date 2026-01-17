const MENU_ID = "chatgpt-dom-cleaner:clean";
const KEEP_LAST_DEFAULT = 3;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Очистить DOM узлы в чате (оставить 3)",
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

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Не нашёл активную вкладку.");
  return tab.id;
}

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

