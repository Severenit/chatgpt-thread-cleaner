(() => {
  const DEFAULT_KEEP_LAST = 4;
  const STORAGE_KEY_KEEP_LAST = "keepLast";
  const BTN_ATTR = "data-chatgpt-dom-cleaner-btn";
  const ICON_HREF = "/cdn/assets/sprites-core-k5zux585.svg#a5ec30";
  const BUTTON_TEXT = "Разгрузить чат";
  const TOAST_MS = 4500;
  const TOAST_ID = "chatgpt-dom-cleaner-toast";
  /** Порог в пикселях для определения "у края". */
  const SCROLL_EDGE_PX = 12;
  /** Сколько сообщений восстанавливать за один батч. */
  const RESTORE_BATCH_SIZE = 8;
  /** Максимум восстановлений за один заход к верху. */
  const RESTORE_MAX_PER_EDGE = 2;
  /** Лимит истории удалённых сообщений на диалог (по количеству записей). */
  const MAX_REMOVED_CACHE = 500;
  /** Имя базы IndexedDB. */
  const IDB_NAME = "chatgpt-dom-cleaner";
  /** Версия базы IndexedDB (для миграций схемы). */
  const IDB_VERSION = 2;
  /** Название objectStore в IndexedDB. */
  const IDB_STORE = "removedMessages";
  let keepLast = DEFAULT_KEEP_LAST;
  let scrollWatcherBound = false;
  let lastEdge = null;
  let scrollTicking = false;
  let scrollTarget = null;
  let scrollListener = null;
  let hasUserScrolled = false;
  let restoreInProgress = false;
  let bootScheduled = false;
  const preventScroll = (e) => e.preventDefault();

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
    const removedHtml = toRemove.map((el) => el.outerHTML);
    for (const el of toRemove) el.remove();
    void appendRemovedMessages(removedHtml);
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
    // После удаления DOM не считаем это пользовательским скроллом.
    hasUserScrolled = false;
    lastEdge = null;
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
   * Возвращает корневой скролл-элемент документа.
   *
   * @returns {HTMLElement}
   */
  function getScrollRoot() {
    return document.scrollingElement ?? document.documentElement;
  }

  /**
   * Уникальный ключ диалога (по pathname).
   *
   * @returns {string}
   */
  /** Возвращает ключ текущего диалога (по pathname). */
  const getConversationKey = () => `${location.pathname}`;

  /**
   * Открывает IndexedDB и гарантирует наличие индексов.
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
   * Урезает историю по диалогу до MAX_REMOVED_CACHE.
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
   * Добавляет пачку удалённых сообщений в IndexedDB.
   *
   * @param {string[]} htmlList
   * @returns {Promise<void>}
   */
  const appendRemovedMessages = async (htmlList) => {
    if (!htmlList.length) return;
    const db = await openDb();
    const conversationKey = getConversationKey();
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

  /**
   * Забирает последние N удалённых сообщений и удаляет их из IndexedDB.
   *
   * @param {number} count
   * @returns {Promise<string[]>}
   */
  const takeRemovedBatch = async (count) => {
    const db = await openDb();
    const conversationKey = getConversationKey();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const index = store.index("conversationKey_id");
      const range = IDBKeyRange.bound(
        [conversationKey, 0],
        [conversationKey, Number.MAX_SAFE_INTEGER]
      );
      const items = [];

      index.openCursor(range, "prev").onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && items.length < count) {
          items.push({ id: cursor.primaryKey, html: cursor.value.html });
          cursor.delete();
          cursor.continue();
          return;
        }
      };

      tx.oncomplete = () => {
        const htmlList = items.reverse().map((item) => item.html);
        resolve(htmlList);
      };
      tx.onerror = () => reject(tx.error || new Error("IDB take failed"));
    });
  };

  /**
   * Восстанавливает ранее удалённые сообщения в начало чата.
   *
   * @param {number} count
   * @returns {Promise<number>} Сколько реально восстановили.
   */
  const restoreMessagesAtTop = async (count) => {
    if (restoreInProgress) return 0;
    restoreInProgress = true;
    try {
      const htmlList = await takeRemovedBatch(count);
      if (!htmlList.length) return 0;

      const fragment = document.createDocumentFragment();
      for (const html of htmlList) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const node = tpl.content.firstElementChild;
        if (node) fragment.appendChild(node);
      }

      const root = document.querySelector("main") ?? document.body;
      const first = getChatArticles()[0] ?? null;
      if (first && first.parentNode) {
        first.parentNode.insertBefore(fragment, first);
      } else {
        root.appendChild(fragment);
      }

      return htmlList.length;
    } finally {
      restoreInProgress = false;
    }
  };

  /**
   * Находит наиболее вероятный скролл-контейнер чата.
   *
   * @returns {HTMLElement}
   */
  function getScrollContainer() {
    const articles = getChatArticles();
    const root = document.querySelector("main") ?? document.body;
    const start = articles.length ? articles[articles.length - 1] : root;

    const isScrollable = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const overflowY = style.overflowY || style.overflow;
      const canScroll = (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 1;
      return canScroll;
    };

    let node = start?.parentElement ?? null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }

    if (isScrollable(root)) return root;
    return getScrollRoot();
  }

  /**
   * Проверяет достижение верхней/нижней границы и триггерит действия.
   *
   * @param {HTMLElement} target
   * @returns {void}
   */
  function checkScrollEdge(target) {
    const root = target ?? getScrollRoot();
    const distanceToBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
    const atTop = root.scrollTop <= SCROLL_EDGE_PX;
    const atBottom = distanceToBottom <= SCROLL_EDGE_PX;

    if (atTop && lastEdge !== "top") {
      lastEdge = "top";
      void (async () => {
        window.addEventListener("wheel", preventScroll, { passive: false });
        window.addEventListener("touchmove", preventScroll, { passive: false });
        try {
          let totalRestored = 0;
          while (totalRestored < RESTORE_MAX_PER_EDGE) {
            const restored = await restoreMessagesAtTop(RESTORE_BATCH_SIZE);
            if (restored <= 0) break;
            totalRestored += restored;
            // если после добавления всё ещё у самого верха — продолжаем
            const root = scrollTarget ?? getScrollRoot();
            if (root.scrollTop > SCROLL_EDGE_PX) break;
          }

          if (totalRestored > 0) {
            const root = scrollTarget ?? getScrollRoot();
            requestAnimationFrame(() => {
              root.scrollTop = Math.max(0, root.scrollTop + 12);
              lastEdge = null;
            });
            console.log(
              `[chatgpt-dom-cleaner] Восстановлено ${totalRestored} сообщений.`
            );
            toast(`Восстановлено ${totalRestored} сообщений`);
          } else {
            console.log("[chatgpt-dom-cleaner] Больше нет сохранённых сообщений.");
            toast("Больше нет сохранённых сообщений");
          }
        } finally {
          window.removeEventListener("wheel", preventScroll);
          window.removeEventListener("touchmove", preventScroll);
        }
      })();
      return;
    }

    if (atBottom && lastEdge !== "bottom") {
      lastEdge = "bottom";
      console.log("[chatgpt-dom-cleaner] Доскроллил до самого низа сообщений.");
      toast("Доскроллил до самого низа сообщений");
      return;
    }

    if (!atTop && !atBottom) {
      lastEdge = null;
    }
  }

  /**
   * Включает наблюдение за скроллом чата (однократно/с ребайндом).
   *
   * @returns {void}
   */
  function ensureScrollEdgeWatcher() {
    const nextTarget = getScrollContainer();
    if (scrollTarget === nextTarget && scrollWatcherBound) return;

    if (scrollListener && scrollTarget) {
      scrollTarget.removeEventListener("scroll", scrollListener);
    }

    scrollTarget = nextTarget;

    const onScroll = () => {
      if (!hasUserScrolled) return;
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        checkScrollEdge(scrollTarget);
      });
    };

    scrollListener = onScroll;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });

    if (!scrollWatcherBound) {
      const markUserScroll = () => {
        hasUserScrolled = true;
      };
      window.addEventListener("wheel", markUserScroll, { passive: true });
      window.addEventListener("touchmove", markUserScroll, { passive: true });
      window.addEventListener("keydown", markUserScroll, { passive: true });
    }

    scrollWatcherBound = true;
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
    if (!canMountIntoHeader(header)) return;

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
   * Проверяет, безопасно ли встраивать кнопку в header
   * (не лезем в SSR/гидратацию React).
   *
   * @param {HTMLElement} header
   * @returns {boolean}
   */
  function canMountIntoHeader(header) {
    if (document.readyState !== "complete") return false;
    // Ждём, когда в хедере появятся реальные элементы управления.
    if (!header.querySelector("button")) return false;
    return true;
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
    ensureScrollEdgeWatcher();
  }

  /**
   * Троттлит `boot()`: не чаще 1 раза за frame.
   *
   * MutationObserver на ChatGPT может стрелять очень часто, поэтому запускаем
   * пере-инициализацию только через rAF.
   *
   * @returns {void}
   */
  function scheduleBoot() {
    if (bootScheduled) return;
    bootScheduled = true;
    requestAnimationFrame(() => {
      bootScheduled = false;
      boot();
    });
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
      scheduleBoot();
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
    scheduleBoot();
  });
  const mo = new MutationObserver(() => scheduleBoot());
  mo.observe(document.documentElement, { subtree: true, childList: true });
})();

