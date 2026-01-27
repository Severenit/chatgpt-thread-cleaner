(() => {
  const ROUTES = [
    // Добавляй свои пути сюда: строка = префикс пути, RegExp = шаблон.
    // Пример: "/backend-api/conversation", /^\/api\/v\d+\//
  ];

  const TARGET_ORIGIN = location.origin;

  const isRouteMatch = (url) => {
    if (!ROUTES.length) return true;
    return ROUTES.some((route) => {
      if (route instanceof RegExp) return route.test(url.pathname);
      if (typeof route === "string") return url.pathname.startsWith(route);
      return false;
    });
  };

  const isTargetUrl = (rawUrl) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return false;
      return isRouteMatch(url);
    } catch {
      return false;
    }
  };

  const CONVERSATION_PATCH_PREFIX = "/backend-api/conversation/";
  const CONVERSATION_GET_PREFIX = "/backend-api/conversation/";
  const CONVERSATIONS_LIST_PATH = "/backend-api/conversations";
  const PINS_PATH = "/backend-api/pins";
  const DB_NAME = "chatgpt-dom-cleaner-proxy";
  const DB_VERSION = 2;
  const DB_STORE = "responses";
  const DB_STORE_KV = "kv";
  const KV_CONVERSATIONS_LIST = "conversationsList";
  const KV_PINS_LIST = "pinsList";
  let lastConversationId = null;
  let cachedConversationsList = null;
  let cachedPinsList = null;

  const isMockConversationPatch = (rawUrl, method) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return false;
      if (String(method || "").toUpperCase() !== "PATCH") return false;
      return url.pathname.startsWith(CONVERSATION_PATCH_PREFIX);
    } catch {
      return false;
    }
  };

  const isConversationsListUrl = (rawUrl) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return false;
      return url.pathname === CONVERSATIONS_LIST_PATH;
    } catch {
      return false;
    }
  };

  const isPinsUrl = (rawUrl) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return false;
      return url.pathname === PINS_PATH;
    } catch {
      return false;
    }
  };

  const extractConversationId = (rawUrl, method) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return null;
      if (String(method || "GET").toUpperCase() !== "GET") return null;
      if (!url.pathname.startsWith(CONVERSATION_GET_PREFIX)) return null;
      const id = url.pathname.slice(CONVERSATION_GET_PREFIX.length);
      return id || null;
    } catch {
      return null;
    }
  };

  const extractConversationIdFromPatch = (rawUrl, method) => {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl, location.origin);
      if (url.origin !== TARGET_ORIGIN) return null;
      if (String(method || "").toUpperCase() !== "PATCH") return null;
      if (!url.pathname.startsWith(CONVERSATION_PATCH_PREFIX)) return null;
      const id = url.pathname.slice(CONVERSATION_PATCH_PREFIX.length);
      return id || null;
    } catch {
      return null;
    }
  };

  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("url", "url", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(DB_STORE_KV)) {
        db.createObjectStore(DB_STORE_KV, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IDB open failed"));
  });

  const saveResponseToDb = async ({ url, status, body }) => {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE_KV, "readwrite");
        const store = tx.objectStore(DB_STORE_KV);
        store.put({
          key: `lastResponse:${url}`,
          value: JSON.stringify({
            url,
            status,
            body,
            createdAt: Date.now()
          }),
          updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IDB kv put failed"));
      });
    } catch {
      // ignore
    }
  };

  const saveConversationsList = async (bodyText) => {
    try {
      const parsed = JSON.parse(bodyText || "null");
      cachedConversationsList = parsed;
    } catch {
      cachedConversationsList = null;
      return;
    }

    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE_KV, "readwrite");
        const store = tx.objectStore(DB_STORE_KV);
        store.put({
          key: KV_CONVERSATIONS_LIST,
          value: JSON.stringify(cachedConversationsList),
          updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IDB kv put failed"));
      });
    } catch {
      // ignore
    }
  };

  const savePinsList = async (pinsList) => {
    const sanitized = sanitizePinsList(pinsList);
    cachedPinsList = sanitized;
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE_KV, "readwrite");
        const store = tx.objectStore(DB_STORE_KV);
        store.put({
          key: KV_PINS_LIST,
          value: JSON.stringify(sanitized),
          updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IDB kv put failed"));
      });
    } catch {
      // ignore
    }
  };

  const loadConversationsList = async () => {
    if (cachedConversationsList != null) return cachedConversationsList;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE_KV, "readonly");
        const store = tx.objectStore(DB_STORE_KV);
        const req = store.get(KV_CONVERSATIONS_LIST);
        req.onsuccess = () => {
          try {
            const value = req.result?.value;
            const parsed = value ? JSON.parse(value) : null;
            cachedConversationsList = parsed;
            resolve(parsed);
          } catch {
            resolve(null);
          }
        };
        req.onerror = () => reject(req.error || new Error("IDB kv get failed"));
      });
    } catch {
      return null;
    }
  };

  const loadPinsList = async () => {
    if (cachedPinsList != null) return sanitizePinsList(cachedPinsList);
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE_KV, "readonly");
        const store = tx.objectStore(DB_STORE_KV);
        const req = store.get(KV_PINS_LIST);
        req.onsuccess = () => {
          try {
            const value = req.result?.value;
            const parsed = value ? JSON.parse(value) : [];
            cachedPinsList = sanitizePinsList(parsed);
            resolve(cachedPinsList);
          } catch {
            resolve([]);
          }
        };
        req.onerror = () => reject(req.error || new Error("IDB kv get failed"));
      });
    } catch {
      return [];
    }
  };

  const getPinnedIds = async () => {
    const pins = await loadPinsList();
    const ids = new Set();
    for (const entry of normalizePinsList(pins)) {
      const id = entry?.item?.id;
      if (id) ids.add(id);
    }
    return ids;
  };

  const normalizeConversationsList = (value) => Array.isArray(value) ? value : [];

  const getConversationIdFromItem = (item) => item?.id || item?.item?.id || null;

  const filterConversationsByPins = async (bodyText) => {
    try {
      const parsed = JSON.parse(bodyText || "null");
      const pinnedIds = await getPinnedIds();
      if (!pinnedIds.size) return { filteredText: bodyText, filtered: null };

      if (Array.isArray(parsed)) {
        const filtered = normalizeConversationsList(parsed)
          .filter((item) => !pinnedIds.has(getConversationIdFromItem(item)));
        return { filteredText: JSON.stringify(filtered), filtered };
      }

      if (Array.isArray(parsed?.items)) {
        const filteredItems = normalizeConversationsList(parsed.items)
          .filter((item) => !pinnedIds.has(getConversationIdFromItem(item)));
        const next = { ...parsed, items: filteredItems };
        return { filteredText: JSON.stringify(next), filtered: next };
      }
    } catch {
      return { filteredText: bodyText, filtered: null };
    }

    return { filteredText: bodyText, filtered: null };
  };

  const findConversationById = async (id) => {
    if (!id) return null;
    const data = await loadConversationsList();
    if (!data) return null;
    if (Array.isArray(data)) {
      return data.find((item) => item?.id === id) || null;
    }
    if (Array.isArray(data?.items)) {
      return data.items.find((item) => item?.id === id) || null;
    }
    return null;
  };

  const normalizePinsList = (value) => Array.isArray(value) ? value : [];

  const isPinnedEntry = (entry) => {
    if (!entry || entry.item_type !== "conversation") return false;
    const item = entry.item;
    if (!item || !item.id) return false;
    return item.is_starred === true || Boolean(item.pinned_time);
  };

  const sanitizePinsList = (list) =>
    normalizePinsList(list).filter((entry) => isPinnedEntry(entry));

  const getPinKey = (entry) => {
    const id = entry?.item?.id;
    if (!id) return null;
    const type = entry?.item_type || "conversation";
    return `${type}:${id}`;
  };

  const mergePinsLists = (...lists) => {
    const result = [];
    const seen = new Set();
    for (const list of lists) {
      for (const entry of sanitizePinsList(list)) {
        const key = getPinKey(entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
      }
    }
    return result;
  };

  const mergePinsResponse = async (pinsBodyText, conversation) => {
    let pinsFromResponse = [];
    try {
      const parsed = JSON.parse(pinsBodyText || "[]");
      pinsFromResponse = sanitizePinsList(parsed);
    } catch {
      return { mergedText: pinsBodyText, mergedList: null };
    }

    const storedPins = sanitizePinsList(await loadPinsList());
    const extraPins = conversation
      ? [{ item: conversation, item_type: "conversation" }]
      : [];
    const mergedList = mergePinsLists(pinsFromResponse, storedPins, extraPins);
    const mergedText = JSON.stringify(mergedList);
    return { mergedText, mergedList };
  };

  const parseJsonSafe = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const upsertPinnedConversation = async (id) => {
    if (!id) return;
    const conversation = await findConversationById(id);
    const item = conversation || { id, is_starred: true };
    item.is_starred = true;
    if (!item.pinned_time) item.pinned_time = new Date().toISOString();
    const entry = { item, item_type: "conversation" };
    const list = sanitizePinsList(await loadPinsList());
    const merged = mergePinsLists(list, [entry]);
    await savePinsList(merged);
  };

  const removePinnedConversation = async (id) => {
    if (!id) return;
    const list = sanitizePinsList(await loadPinsList());
    const next = normalizePinsList(list)
      .filter((entry) => entry?.item?.id !== id);
    await savePinsList(next);
  };

  const updatePinsFromPatchBody = async (id, bodyText) => {
    const payload = parseJsonSafe(bodyText || "");
    if (!payload || typeof payload !== "object") return;
    if (payload.is_starred === true) {
      logText("pin add", id);
      await upsertPinnedConversation(id);
      return;
    }
    if (payload.is_starred === false) {
      logText("pin remove", id);
      await removePinnedConversation(id);
    }
  };

  const safeReadText = async (body) => {
    try {
      return await body.text();
    } catch {
      return null;
    }
  };

  const normalizeBodyForLog = (body) => {
    if (body == null) return null;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    return `[${body?.constructor?.name || "unknown"}]`;
  };

  const logText = (label, data) => {
    const ts = new Date().toISOString();
    if (data !== undefined) {
      console.log(`[Proxy][${ts}] ${label}`, data);
      return;
    }
    console.log(`[Proxy][${ts}] ${label}`);
  };

  const logExchange = ({ type, method, url, status, requestBody, responseBody }) => {
    logText(`${type} ${method} ${url}`);
    logText("status:", status);
    logText("requestBody:", requestBody);
    logText("responseBody:", responseBody);
    logText("---");
  };

  // Инструкция: чтобы модифицировать ответ для всех HTTP методов,
  // 1) В fetch-ветке верни new Response(modifiedBody, { status, headers }).
  // 2) В XHR-ветке задай модифицированное значение в responseText/response
  //    через Object.defineProperty перед использованием.

  const interceptFetch = () => {
    if (!window.fetch) return;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const shouldMock = isMockConversationPatch(request.url, request.method);
      const shouldIntercept = isTargetUrl(request.url);
      const conversationId = extractConversationId(request.url, request.method);

      if (!shouldIntercept && !shouldMock) return originalFetch(input, init);

      const requestBody = await safeReadText(request.clone());
      if (conversationId) lastConversationId = conversationId;
      const patchConversationId = extractConversationIdFromPatch(request.url, request.method);
      if (patchConversationId && requestBody) {
        await updatePinsFromPatchBody(patchConversationId, requestBody);
      }

      if (shouldMock) {
        const responseBody = JSON.stringify({ success: true });
        const response = new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
        logExchange({
          type: "fetch",
          method: request.method,
          url: request.url,
          status: response.status,
          requestBody,
          responseBody
        });
        return response;
      }

      const response = await originalFetch(input, init);
      let responseBody = await safeReadText(response.clone());

      if (isConversationsListUrl(request.url)) {
        const originalBody = responseBody ?? "";
        void saveResponseToDb({
          url: request.url,
          status: response.status,
          body: originalBody
        });
        if (responseBody != null) void saveConversationsList(originalBody);

        const { filteredText } = await filterConversationsByPins(originalBody);
        if (filteredText !== responseBody) {
          responseBody = filteredText;
          const headers = new Headers(response.headers);
          headers.set("content-type", "application/json; charset=utf-8");
          const modified = new Response(responseBody, {
            status: response.status,
            headers
          });
          logExchange({
            type: "fetch",
            method: request.method,
            url: request.url,
            status: response.status,
            requestBody,
            responseBody
          });
          return modified;
        }
      }

      if (isPinsUrl(request.url)) {
        const conversation = lastConversationId
          ? await findConversationById(lastConversationId)
          : null;
        const { mergedText, mergedList } = await mergePinsResponse(
          responseBody ?? "[]",
          conversation
        );
        if (mergedText !== responseBody) {
          responseBody = mergedText;
          if (mergedList) void savePinsList(mergedList);
          const headers = new Headers(response.headers);
          headers.set("content-type", "application/json; charset=utf-8");
          const modified = new Response(responseBody, {
            status: response.status,
            headers
          });
          logExchange({
            type: "fetch",
            method: request.method,
            url: request.url,
            status: response.status,
            requestBody,
            responseBody
          });
          return modified;
        }
        if (mergedList) void savePinsList(mergedList);
      }

      logExchange({
        type: "fetch",
        method: request.method,
        url: request.url,
        status: response.status,
        requestBody,
        responseBody
      });

      return response;
    };
  };

  const interceptXhr = () => {
    if (!window.XMLHttpRequest) return;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__proxyMeta = { method, url: String(url) };
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(body) {
      const meta = this.__proxyMeta || { method: "GET", url: "" };
      const shouldIntercept = isTargetUrl(meta.url);
      const shouldMock = isMockConversationPatch(meta.url, meta.method);
      const conversationId = extractConversationId(meta.url, meta.method);
      const patchConversationId = extractConversationIdFromPatch(meta.url, meta.method);
      if (conversationId) lastConversationId = conversationId;
      if (patchConversationId && typeof body === "string") {
        void updatePinsFromPatchBody(patchConversationId, body);
      }

      if (shouldMock) {
        const requestBody = normalizeBodyForLog(body);
        const responseBody = JSON.stringify({ success: true });
        const responseValue = this.responseType === "json"
          ? { success: true }
          : responseBody;
        const run = async () => {
          if (patchConversationId && typeof body === "string") {
            await updatePinsFromPatchBody(patchConversationId, body);
          }
          try {
            Object.defineProperty(this, "status", { configurable: true, value: 200 });
            Object.defineProperty(this, "statusText", { configurable: true, value: "OK" });
            Object.defineProperty(this, "readyState", { configurable: true, value: 4 });
            Object.defineProperty(this, "responseText", { configurable: true, value: responseBody });
            Object.defineProperty(this, "response", { configurable: true, value: responseValue });
          } catch {
            // ignore
          }

          logExchange({
            type: "xhr",
            method: meta.method,
            url: meta.url,
            status: 200,
            requestBody,
            responseBody
          });

          this.dispatchEvent(new Event("readystatechange"));
          this.dispatchEvent(new Event("load"));
          this.dispatchEvent(new Event("loadend"));
        };
        void run();
        return undefined;
      }

      if (shouldIntercept) {
        const requestBody = normalizeBodyForLog(body);
        this.addEventListener("load", async () => {
          let responseBody = null;
          try {
            if (this.responseType && this.responseType !== "text") {
              responseBody = this.response;
            } else {
              responseBody = this.responseText;
            }
          } catch {
            responseBody = null;
          }

          if (isConversationsListUrl(meta.url)) {
            const bodyForDb = typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody ?? null);
            void saveResponseToDb({
              url: meta.url,
              status: this.status,
              body: bodyForDb ?? ""
            });
            if (bodyForDb != null) void saveConversationsList(bodyForDb);

            const { filteredText } = await filterConversationsByPins(bodyForDb ?? "");
            if (filteredText !== bodyForDb) {
              const responseValue = this.responseType === "json"
                ? JSON.parse(filteredText)
                : filteredText;
              try {
                Object.defineProperty(this, "responseText", { configurable: true, value: filteredText });
                Object.defineProperty(this, "response", { configurable: true, value: responseValue });
              } catch {
                // ignore
              }
              responseBody = responseValue;
            }
          }

          if (isPinsUrl(meta.url)) {
            const conversation = lastConversationId
              ? await findConversationById(lastConversationId)
              : null;
            const bodyText = typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody ?? null);
            const { mergedText, mergedList } = await mergePinsResponse(
              bodyText ?? "[]",
              conversation
            );
            if (mergedText !== bodyText) {
              const responseValue = this.responseType === "json"
                ? JSON.parse(mergedText)
                : mergedText;
              try {
                Object.defineProperty(this, "responseText", { configurable: true, value: mergedText });
                Object.defineProperty(this, "response", { configurable: true, value: responseValue });
              } catch {
                // ignore
              }
              responseBody = responseValue;
            }
            if (mergedList) void savePinsList(mergedList);
          }

          logExchange({
            type: "xhr",
            method: meta.method,
            url: meta.url,
            status: this.status,
            requestBody,
            responseBody
          });
        });
      }

      return originalSend.call(this, body);
    };
  };

  console.log("[Proxy] Active for", TARGET_ORIGIN, "routes:", ROUTES.length || "ALL");
  interceptFetch();
  interceptXhr();
})();
