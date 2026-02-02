(() => {
  const DEFAULT_KEEP_LAST = 4;
  const STORAGE_KEY_KEEP_LAST = "keepLast";
  const STORAGE_KEY_LANG_OVERRIDE = "langOverride"; // "auto" | "en" | "ru"
  const BTN_ATTR = "data-chatgpt-dom-cleaner-btn";
  const ICON_HREF = "/cdn/assets/sprites-core-k5zux585.svg#a5ec30";
  const TOAST_MS = 4500;
  const TOAST_ID = "chatgpt-dom-cleaner-toast";
  /** Threshold (px) to consider the user "at an edge". */
  const SCROLL_EDGE_PX = 12;
  /** How many messages to restore per batch. */
  const RESTORE_BATCH_SIZE = 8;
  /** Max restore batches per reaching the top edge. */
  const RESTORE_MAX_PER_EDGE = 2;
  /** Per-conversation removed-messages history limit (by number of records). */
  const MAX_REMOVED_CACHE = 500;
  /** IndexedDB database name. */
  const IDB_NAME = "chatgpt-dom-cleaner";
  /** IndexedDB version (for schema migrations). */
  const IDB_VERSION = 2;
  /** IndexedDB objectStore name. */
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

    // Content scripts are subject to the page origin/CORS when fetching extension URLs.
    // Load via the extension service worker instead.
    const res = await chrome.runtime.sendMessage({ type: "GET_LOCALE_MESSAGES", locale });
    if (!res?.ok) throw new Error(res?.error || `Failed to load locale ${locale}`);
    const json = res.messages;
    if (!json) throw new Error(`No messages for locale ${locale}`);
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

  const getButtonText = () => t("inpageButtonText") || "Lighten chat";

  /**
   * Returns the list of message DOM nodes for the current conversation.
   *
   * First, it tries a more stable ChatGPT selector:
   * `article[data-testid^="conversation-turn"]`.
   * If markup changes, it falls back to `article`.
   *
   * Important: search is scoped to `main` to avoid accidentally targeting `article`
   * outside the conversation area.
   *
   * @returns {HTMLElement[]} List of `article` elements (DOM order).
   */
  function getChatArticles() {
    const root = document.querySelector("main") ?? document.body;
    if (!root) return [];
    const primary = Array.from(
      root.querySelectorAll('article[data-testid^="conversation-turn"]')
    );
    return primary.length ? primary : Array.from(root.querySelectorAll("article"));
  }

  /**
   * Cleans the DOM: removes old messages, keeping the last `keepLast`.
   *
   * @param {number} keepLast - How many last messages to keep.
   * @returns {{total:number, removed:number, kept:number}} Counters before/after.
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
   * Runs cleanup and shows a toast with the result.
   *
   * Side effect: removes message DOM nodes.
   */
  function runAndToast() {
    const { total, removed, kept } = cleanChatDom(keepLast);
    toast(
      t("inpageToastCleanupSummary", [String(removed), String(total), String(kept)]) ||
        `Chat cleanup: removed ${removed} of ${total}, kept ${kept}`
    );
    // After DOM removal, don't treat it as a user scroll.
    hasUserScrolled = false;
    lastEdge = null;
  }

  /**
   * Shows a "modal toast" in the bottom-right corner.
   * Subsequent calls replace the previous toast (avoid spamming).
   *
   * @param {string} text - Message text.
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

    // next tick — show
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
   * Returns the document scroll root element.
   *
   * @returns {HTMLElement}
   */
  function getScrollRoot() {
    return document.scrollingElement ?? document.documentElement ?? document.body;
  }

  /**
   * Returns a unique conversation key (by pathname).
   *
   * @returns {string}
   */
  const getConversationKey = () => `${location.pathname}`;

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
   * Takes the latest N removed messages and deletes them from IndexedDB.
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
   * Restores previously removed messages to the top of the chat.
   *
   * @param {number} count
   * @returns {Promise<number>} How many were actually restored.
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
   * Finds the most likely chat scroll container.
   *
   * @returns {HTMLElement}
   */
  function getScrollContainer() {
    const articles = getChatArticles();
    const root = document.querySelector("main") ?? document.body;
    if (!root) return getScrollRoot();

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
   * Checks whether the user reached top/bottom edge and triggers actions.
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
            // if still at the very top after inserting — continue
            const root = scrollTarget ?? getScrollRoot();
            if (root.scrollTop > SCROLL_EDGE_PX) break;
          }

          if (totalRestored > 0) {
            const root = scrollTarget ?? getScrollRoot();
            requestAnimationFrame(() => {
              root.scrollTop = Math.max(0, root.scrollTop + 12);
              lastEdge = null;
            });
            toast(t("inpageToastRestored", [String(totalRestored)]) || `Restored ${totalRestored} messages`);
          } else {
            toast(t("inpageToastNoSavedMessages") || "No saved messages left");
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
      toast(t("inpageToastBottom") || "Scrolled to the very bottom");
      return;
    }

    if (!atTop && !atBottom) {
      lastEdge = null;
    }
  }

  /**
   * Enables chat scroll edge watching (one-time/bind-and-rebind).
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
    if (!scrollTarget) return;

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
   * Mounts the "Lighten chat" button into the ChatGPT header (near "Share"),
   * or updates visibility of the existing one.
   *
   * The button is shown only if message count > keepLast.
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
      updateHeaderButtonText(existing);
      updateHeaderButtonLabel(existing);
      return;
    }

    // Try to mount near the "Share" button. If not found — append to the end of the header.
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

    // Insert before Share if present; otherwise append to the end.
    if (shareBtn && shareBtn.parentElement) {
      shareBtn.insertAdjacentElement("beforebegin", btn);
    } else {
      mountPoint.appendChild(btn);
    }

    updateHeaderButtonVisibility(btn);
    updateHeaderButtonText(btn);
    updateHeaderButtonLabel(btn);
  }

  /**
   * Checks whether it's safe to mount into the header
   * (avoid interfering with React SSR/hydration).
   *
   * @param {HTMLElement} header
   * @returns {boolean}
   */
  function canMountIntoHeader(header) {
    if (document.readyState !== "complete") return false;
    // Wait until real controls appear in the header.
    if (!header.querySelector("button")) return false;
    return true;
  }

  /**
   * Hides the button in a new/short conversation (when there's nothing to clean).
   *
   * @param {HTMLElement} btn - Button to show/hide.
   */
  function updateHeaderButtonVisibility(btn) {
    // In a new chat / when messages are few — the button isn't needed.
    const total = getChatArticles().length;
    const shouldShow = total > keepLast;
    btn.style.display = shouldShow ? "" : "none";
  }

  /**
   * Updates button label/tooltip (since keepLast is configurable).
   *
   * @param {HTMLButtonElement} btn
   */
  function updateHeaderButtonLabel(btn) {
    const aria =
      t("inpageAriaLabel", [String(keepLast)]) ||
      `Lighten chat (remove old messages from the DOM, keep ${keepLast})`;
    btn.setAttribute("aria-label", aria);
    btn.setAttribute("title", aria);

    // If this is our fallback (no ChatGPT SVG structure) — update the text.
    if (!btn.querySelector("svg")) {
      btn.textContent =
        t("inpageFallbackButtonText", [String(keepLast)]) || `Lighten chat (keep ${keepLast})`;
    }
  }

  /**
   * Updates the visible button text (both SVG + non-SVG variants).
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  function updateHeaderButtonText(btn) {
    const flex = btn.querySelector("div");
    if (!flex) return;

    const text = getButtonText();
    const svg = flex.querySelector("svg");
    if (svg) {
      // Ensure the icon stays as our sprite.
      const use = svg.querySelector("use");
      if (use) {
        use.setAttribute("href", ICON_HREF);
        use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ICON_HREF);
      }
      flex.innerHTML = `${svg.outerHTML}${text}`;
      return;
    }

    flex.textContent = text;
  }

  /**
   * Finds the "Share" button within the provided scope.
   * Used as an "anchor" to insert our button next to it.
   *
   * @param {ParentNode} scope - Container to search in.
   * @returns {HTMLButtonElement|null} The Share button if found.
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
   * Builds a button that closely matches "Share": clones DOM, swaps icon and text,
   * and removes Share-specific attributes.
   *
   * @param {HTMLButtonElement} shareBtn - Original Share button.
   * @returns {HTMLButtonElement} New "Lighten chat" button.
   */
  function cloneShareButtonAsCleaner(shareBtn) {
    const btn = shareBtn.cloneNode(true);

    // Remove Share-specific attributes to avoid breaking page logic.
    btn.removeAttribute("data-testid");
    btn.removeAttribute("style"); // view-transition-name
    // aria/title are set dynamically in updateHeaderButtonLabel()

    // Small left gap from Share.
    btn.classList.add("mr-2");

    // Change only the text, preserving the SVG + flex structure.
    const flex = btn.querySelector("div");
    if (flex) {
      const svg = flex.querySelector("svg");
      if (svg) {
        // Swap the icon to the target sprite id.
        const use = svg.querySelector("use");
        if (use) {
          use.setAttribute("href", ICON_HREF);
          // Safari/older engines: just in case.
          use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ICON_HREF);
        }

        flex.innerHTML = `${svg.outerHTML}${getButtonText()}`;
      } else {
        flex.textContent = getButtonText();
      }
    } else {
      btn.textContent = getButtonText();
    }

    return btn;
  }

  /**
   * Fallback button if we couldn't find/clone Share.
   * Provides basic functionality without depending on ChatGPT UI classes.
   *
   * @returns {HTMLButtonElement} "Lighten chat (keep N)" button.
   */
  function createFallbackCleanerButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent =
      t("inpageFallbackButtonText", [String(keepLast)]) || `Lighten chat (keep ${keepLast})`;
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

  const DROPDOWN_WRAPPER_SELECTOR =
    '[data-rad1x-popper-content-wrapper], [data-radix-popper-content-wrapper]';

  /**
   * Subscribes to clicks inside the sidebar context menu (popper dropdown).
   * Dropdown is added to DOM only when opened, so we use MutationObserver to
   * attach a capture-phase listener to the wrapper as soon as it appears —
   * then we catch the click even if the library stops propagation.
   */
  function bindDropdownClickLogger() {
    if (document.__chatgptCleanerDropdownLoggerBound) return;
    document.__chatgptCleanerDropdownLoggerBound = true;

    const seenWrappers = new WeakSet();
    const attachToWrappers = (root) => {
      const list = root.matches?.(DROPDOWN_WRAPPER_SELECTOR)
        ? [root]
        : Array.from(root.querySelectorAll?.(DROPDOWN_WRAPPER_SELECTOR) ?? []);
      for (const wrapper of list) {
        if (seenWrappers.has(wrapper)) continue;
        seenWrappers.add(wrapper);
      }
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          attachToWrappers(node);
        }
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  }

  /**
   * Single refresh entry point for UI injection:
   * - header button near "Share"
   */
  function boot() {
    ensureHeaderButton();
    ensureScrollEdgeWatcher();
    bindDropdownClickLogger();
  }

  /**
   * Throttles `boot()` to at most once per frame.
   *
   * ChatGPT's MutationObserver can fire very frequently, so we only re-init via rAF.
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
   * Normalizes `keepLast`: finite number, integer, range [1..99].
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
   * Pulls `keepLast` from `chrome.storage.sync` and updates UI/logic.
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

  // Initial boot + observer (React frequently re-renders header/menus).
  void (async () => {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    await syncLangOverrideFromStorage();
    await syncKeepLastFromStorage();
    boot();
  })();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const keepChanged = Boolean(changes?.[STORAGE_KEY_KEEP_LAST]);
    const langChanged = Boolean(changes?.[STORAGE_KEY_LANG_OVERRIDE]);
    if (!keepChanged && !langChanged) return;

    if (keepChanged) {
      keepLast = sanitizeKeepLast(changes[STORAGE_KEY_KEEP_LAST]?.newValue);
    }

    if (langChanged) {
      void syncLangOverrideFromStorage().then(() => scheduleBoot());
      return;
    }

    scheduleBoot();
  });
  const mo = new MutationObserver(() => scheduleBoot());
  mo.observe(document.documentElement, { subtree: true, childList: true });
})();

