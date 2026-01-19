(() => {
  const DEFAULT_KEEP_LAST = 4;
  const STORAGE_KEY_KEEP_LAST = "keepLast";
  const BTN_ATTR = "data-chatgpt-dom-cleaner-btn";
  const ICON_HREF = "/cdn/assets/sprites-core-k5zux585.svg#a5ec30";
  const BUTTON_TEXT = "Разгрузить чат";
  const TOAST_MS = 4500;
  const TOAST_ID = "chatgpt-dom-cleaner-toast";
  let keepLast = DEFAULT_KEEP_LAST;

  /**
   * Возвращает список DOM-узлов сообщений текущего диалога.
   *
   * Сначала пробует более стабильный селектор ChatGPT:
   * `article[data-testid^="conversation-turn"]`.
   * Если разметка изменилась — fallback на `article`.
   *
   * Важно: поиск ограничен `main`, чтобы случайно не затронуть `article`
   * вне области диалога.
   *
   * @returns {HTMLElement[]} Список `article` (по DOM-порядку).
   */
  function getChatArticles() {
    const root = document.querySelector("main") ?? document.body;
    const primary = Array.from(
      root.querySelectorAll('article[data-testid^="conversation-turn"]')
    );
    return primary.length ? primary : Array.from(root.querySelectorAll("article"));
  }

  /**
   * Чистит DOM: удаляет старые сообщения, оставляя последние `keepLast`.
   *
   * @param {number} keepLast - Сколько последних сообщений оставить.
   * @returns {{total:number, removed:number, kept:number}} Счётчики до/после.
   */
  function cleanChatDom(keepLastArg) {
    const keep = sanitizeKeepLast(keepLastArg);
    const nodes = getChatArticles();

    const total = nodes.length;
    if (total <= keep) return { total, removed: 0, kept: total };

    const toRemove = nodes.slice(0, total - keep);
    for (const el of toRemove) el.remove();
    return { total, removed: toRemove.length, kept: keep };
  }

  /**
   * Запускает очистку и показывает toast с результатом.
   *
   * Сайд-эффект: удаляет DOM-узлы сообщений.
   */
  function runAndToast() {
    const { total, removed, kept } = cleanChatDom(keepLast);
    toast(`Разгрузка чата: удалено ${removed} из ${total}, оставлено ${kept}`);
  }

  /**
   * Показывает “модалку-тост” в правом нижнем углу.
   * Повторный вызов заменяет предыдущий toast (чтобы не спамить).
   *
   * @param {string} text - Текст сообщения.
   */
  function toast(text) {
    const prev = document.getElementById(TOAST_ID);
    if (prev) prev.remove();

    const el = document.createElement("div");
    el.id = TOAST_ID;
    el.textContent = text;
    el.style.position = "fixed";
    el.style.zIndex = "2147483647";
    el.style.right = "12px";
    el.style.bottom = "12px";
    el.style.maxWidth = "420px";
    el.style.padding = "10px 12px";
    el.style.borderRadius = "10px";
    el.style.background = "rgba(20,20,20,0.9)";
    el.style.color = "white";
    el.style.font = "12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity 120ms ease, transform 120ms ease";
    document.documentElement.appendChild(el);

    // next tick — показать
    queueMicrotask(() => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });

    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      setTimeout(() => el.remove(), 160);
    }, TOAST_MS);
  }

  /**
   * Встраивает кнопку “Разгрузить чат” в хедер ChatGPT (рядом с “Поделиться”),
   * либо обновляет видимость уже существующей.
   *
   * Кнопка показывается только если сообщений > keepLast.
   */
  function ensureHeaderButton() {
    const header =
      document.querySelector("header") ??
      document.querySelector('main [role="banner"]') ??
      null;
    if (!header) return;

    const existing = header.querySelector(`[${BTN_ATTR}="1"]`);
    if (existing) {
      updateHeaderButtonVisibility(existing);
      return;
    }

    // Пытаемся прикрепиться рядом с кнопкой "Поделиться"/"Share". Если не нашли — просто в конец header.
    const shareBtn = findShareButton(header);
    const mountPoint = shareBtn?.parentElement ?? header;

    const btn = shareBtn
      ? cloneShareButtonAsCleaner(shareBtn)
      : createFallbackCleanerButton();

    btn.setAttribute(BTN_ATTR, "1");

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAndToast();
    });

    // Вставляем после share, если он есть, иначе в конец.
    if (shareBtn && shareBtn.parentElement) {
      shareBtn.insertAdjacentElement("beforebegin", btn);
    } else {
      mountPoint.appendChild(btn);
    }

    updateHeaderButtonVisibility(btn);
    updateHeaderButtonLabel(btn);
  }

  /**
   * Скрывает кнопку на новом/коротком диалоге (когда чистить нечего).
   *
   * @param {HTMLElement} btn - Кнопка, которую нужно показать/скрыть.
   */
  function updateHeaderButtonVisibility(btn) {
    // В новом чате/когда сообщений мало — кнопка не нужна.
    const total = getChatArticles().length;
    const shouldShow = total > keepLast;
    btn.style.display = shouldShow ? "" : "none";
  }

  /**
   * Обновляет label/tooltip у кнопки (поскольку keepLast настраиваемый).
   *
   * @param {HTMLButtonElement} btn
   */
  function updateHeaderButtonLabel(btn) {
    const aria = `Разгрузить чат (удалить старые сообщения из DOM, оставить ${keepLast})`;
    btn.setAttribute("aria-label", aria);
    btn.setAttribute("title", aria);

    // Если это наш fallback (без ChatGPT разметки) — обновим текст.
    if (!btn.querySelector("svg")) {
      btn.textContent = `Разгрузить чат (оставить ${keepLast})`;
    }
  }

  /**
   * Ищет кнопку “Поделиться/Share” в переданном scope.
   * Используется как “якорь” для вставки нашей кнопки.
   *
   * @param {ParentNode} scope - Контейнер, где ищем кнопку.
   * @returns {HTMLButtonElement|null} Кнопка Share, если найдена.
   */
  function findShareButton(scope) {
    const candidates = Array.from(scope.querySelectorAll("button"));
    for (const b of candidates) {
      const label = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").trim();
      if (label === "Поделиться" || label === "Share") return b;
      if (txt === "Поделиться" || txt === "Share") return b;
    }
    return null;
  }

  /**
   * Делает кнопку, максимально похожую на “Поделиться”: клонирует DOM,
   * подменяет иконку и текст, убирает специфичные атрибуты.
   *
   * @param {HTMLButtonElement} shareBtn - Оригинальная кнопка Share.
   * @returns {HTMLButtonElement} Новая кнопка “Разгрузить чат”.
   */
  function cloneShareButtonAsCleaner(shareBtn) {
    const btn = shareBtn.cloneNode(true);

    // Снимаем специфичные для Share атрибуты, чтобы не ломать логику страницы.
    btn.removeAttribute("data-testid");
    btn.removeAttribute("style"); // view-transition-name
    // aria/title выставляем динамически в updateHeaderButtonLabel()

    // Небольшой отступ от Share влево.
    btn.classList.add("mr-2");

    // Меняем только текст, сохраняя SVG и flex-структуру.
    const flex = btn.querySelector("div");
    if (flex) {
      const svg = flex.querySelector("svg");
      if (svg) {
        // Подменяем иконку на нужный sprite id.
        const use = svg.querySelector("use");
        if (use) {
          use.setAttribute("href", ICON_HREF);
          // Safari/старый движок: на всякий случай.
          use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ICON_HREF);
        }

        flex.innerHTML = `${svg.outerHTML}${BUTTON_TEXT}`;
      } else {
        flex.textContent = BUTTON_TEXT;
      }
    } else {
      btn.textContent = BUTTON_TEXT;
    }

    return btn;
  }

  /**
   * Fallback-кнопка, если не удалось найти/клонировать Share.
   * Даёт базовую функциональность без зависимости от классов ChatGPT UI.
   *
   * @returns {HTMLButtonElement} Кнопка “Разгрузить чат (оставить 4)”.
   */
  function createFallbackCleanerButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Разгрузить чат (оставить ${keepLast})`;
    btn.style.marginLeft = "8px";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "10px";
    btn.style.border = "1px solid rgba(127,127,127,0.35)";
    btn.style.background = "transparent";
    btn.style.color = "inherit";
    btn.style.cursor = "pointer";
    btn.style.font = "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    btn.style.whiteSpace = "nowrap";
    return btn;
  }

  /**
   * Единая точка “обновления” UI-инъекции:
   * - кнопка в хедере рядом с “Поделиться/Share”
   */
  function boot() {
    ensureHeaderButton();
  }

  /**
   * Нормализует keepLast: число, целое, диапазон [1..99].
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
   * Подтягивает keepLast из chrome.storage.sync и обновляет UI/логику.
   *
   * @returns {Promise<void>}
   */
  async function syncKeepLastFromStorage() {
    try {
      const raw = await chrome.storage.sync.get([STORAGE_KEY_KEEP_LAST]);
      keepLast = sanitizeKeepLast(raw?.[STORAGE_KEY_KEEP_LAST]);
      boot();
    } catch {
      // ignore
    }
  }

  // Первичный запуск + наблюдатель (React часто перерисовывает хедер/менюшки).
  boot();
  void syncKeepLastFromStorage();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes?.[STORAGE_KEY_KEEP_LAST]) return;
    keepLast = sanitizeKeepLast(changes[STORAGE_KEY_KEEP_LAST]?.newValue);
    boot();
  });
  const mo = new MutationObserver(() => boot());
  mo.observe(document.documentElement, { subtree: true, childList: true });
})();

