/**
 * API Interceptor для ChatGPT
 * Логирует запросы к /pins, /conversations, /conversation/
 * Перехватывает is_starred запросы и управляет локальным списком starred тредов
 */
(() => {

  window.isLogging = true;

  // Переключает логирование
  window.loggingOff = () => {
    window.isLogging = !window.isLogging;
  };

  window.loggingOn = () => {
    window.isLogging = true;
  };

  // Вспомогательные функции для управления starred тредами
  window.getStarredThreads = async () => {
    const ids = await getStarredThreadIds();
    return ids;
  };

  window.clearAllStarred = async () => {
    if (!db) await initDB();
    const transaction = db.transaction([STORE_STARRED], 'readwrite');
    const store = transaction.objectStore(STORE_STARRED);
    await store.clear();
  };

  // ==================== IndexedDB для хранения тредов ====================

  const DB_NAME = 'ChatGPTThreadsDB';
  const DB_VERSION = 1;
  const STORE_THREADS = 'threads';
  const STORE_STARRED = 'starred';

  let db = null;

  // Инициализация базы данных
  const initDB = () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Хранилище для всех тредов
        if (!db.objectStoreNames.contains(STORE_THREADS)) {
          db.createObjectStore(STORE_THREADS, { keyPath: 'id' });
        }

        // Хранилище для starred thread IDs
        if (!db.objectStoreNames.contains(STORE_STARRED)) {
          db.createObjectStore(STORE_STARRED, { keyPath: 'id' });
        }
      };
    });
  };

  // Добавить тред в starred
  const addStarredThread = async (threadId) => {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_STARRED], 'readwrite');
      const store = transaction.objectStore(STORE_STARRED);
      const request = store.put({ id: threadId, timestamp: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  // Удалить тред из starred
  const removeStarredThread = async (threadId) => {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_STARRED], 'readwrite');
      const store = transaction.objectStore(STORE_STARRED);
      const request = store.delete(threadId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  // Получить все starred thread IDs
  const getStarredThreadIds = async () => {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_STARRED], 'readonly');
      const store = transaction.objectStore(STORE_STARRED);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  // Сохранить треды из списка
  const saveThreads = async (threads) => {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_THREADS], 'readwrite');
      const store = transaction.objectStore(STORE_THREADS);

      threads.forEach(thread => {
        store.put(thread);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  };

  // Получить полные данные о starred тредах
  const getStarredThreadsData = async () => {
    if (!db) await initDB();

    // Получаем starred записи (с timestamp)
    const starredRecords = await new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_STARRED], 'readonly');
      const store = transaction.objectStore(STORE_STARRED);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (starredRecords.length === 0) {
      return [];
    }

    // Получаем полные данные тредов
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_THREADS], 'readonly');
      const store = transaction.objectStore(STORE_THREADS);
      const threads = [];
      let completed = 0;

      starredRecords.forEach(record => {
        const request = store.get(record.id);
        request.onsuccess = () => {
          let thread;
          if (request.result) {
            // Обновляем флаги для starred треда
            thread = {
              ...request.result,
              is_starred: true,
              pinned_time: new Date(record.timestamp).toISOString()
            };
          } else {
            // Если треда нет в STORE_THREADS, создаем минимальный объект
            thread = {
              id: record.id,
              title: 'Loading...', // Заглушка для title
              create_time: new Date(record.timestamp).toISOString(),
              update_time: new Date(record.timestamp).toISOString(),
              is_starred: true,
              pinned_time: new Date(record.timestamp).toISOString()
            };
          }
          threads.push({ thread, timestamp: record.timestamp });

          completed++;
          if (completed === starredRecords.length) {
            // Сортируем по времени добавления (новые первыми)
            threads.sort((a, b) => b.timestamp - a.timestamp);
            resolve(threads.map(t => t.thread));
          }
        };
        request.onerror = () => {
          completed++;
          if (completed === starredRecords.length) {
            threads.sort((a, b) => b.timestamp - a.timestamp);
            resolve(threads.map(t => t.thread));
          }
        };
      });

      transaction.onerror = () => reject(transaction.error);
    });
  };

  // Инициализируем БД при загрузке
  initDB().catch(err => console.error('Failed to init DB:', err));

  // Функция для закрытия dropdown меню
  const closeDropdown = () => {
    try {
      // Селектор для dropdown wrapper из inpage.js
      const DROPDOWN_WRAPPER_SELECTOR = '[data-radix-popper-content-wrapper], [data-rad1x-popper-content-wrapper]';

      // Находим открытый dropdown
      const dropdown = document.querySelector(DROPDOWN_WRAPPER_SELECTOR);

      if (dropdown) {

        // Способ 1: Симулируем ESC для закрытия
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true
        }));

        // Способ 2: Клик вне dropdown
        setTimeout(() => {
          document.body.click();
        }, 10);

        return true;
      }

      return false;
    } catch (e) {
      console.warn('Failed to close dropdown:', e);
      return false;
    }
  };

  // Функция для принудительного обновления React UI
  const forceReactUpdate = () => {
    try {
      // Сначала пытаемся закрыть dropdown
      const dropdownClosed = closeDropdown();

      if (dropdownClosed) {
        return;
      }

      // Если dropdown не был открыт, пробуем общее обновление
      const appRoot = document.querySelector('#__next') || document.querySelector('[id^="root"]') || document.body;

      const fiberKey = Object.keys(appRoot).find(key =>
        key.startsWith('__reactFiber') ||
        key.startsWith('__reactInternalInstance') ||
        key.startsWith('_reactRootContainer')
      );

      if (fiberKey) {
        const fiber = appRoot[fiberKey];

        let current = fiber;
        while (current) {
          if (current.stateNode && typeof current.stateNode.forceUpdate === 'function') {
            current.stateNode.forceUpdate();
            break;
          }
          current = current.return;
        }
      }

      window.dispatchEvent(new Event('storage'));
      window.dispatchEvent(new Event('focus'));

    } catch (e) {
      console.error('Failed to force React update:', e);
    }
  };

  const logToConsole = (method, url, requestData, responseData, headers, status) => {
    if(!window.isLogging){
      return;
    }
    const color = url.includes('/pins') ? '#ff6b00' : 
                  url.includes('/conversations') ? '#10a37f' : '#0066cc';
    const marker = url.includes('/pins') ? ' 📌 PINS' : 
                   url.includes('/conversations') ? ' 💬 CONVS' : ' 💬 CONV';

    console.group(`%c${method} ${url}${marker}`, `color: ${color}; font-weight: bold`);
    console.log('%cTimestamp:', 'color: #666', new Date().toISOString());
    console.log('%cStatus:', 'color: #666', status);
    if (requestData) console.log('%cRequest:', 'color: #0066cc', requestData);
    console.log('%cResponse:', 'color: #00aa00', responseData);
    if (headers) console.log('%cHeaders:', 'color: #999', headers);
    console.groupEnd();
  };

  const shouldLog = (url) =>
    url?.includes('/pins') ||
    url?.includes('/conversations') ||
    url?.includes('/conversation/');

  // Получить данные треда с сервера
  const fetchThreadData = async (threadId) => {
    try {
      const response = await fetch(`https://chatgpt.com/backend-api/conversation/${threadId}`, {
        credentials: 'include'
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (e) {
      console.error('Error fetching thread data:', e);
    }
    return null;
  };

  // Проверка и обработка is_starred запросов
  const handleStarRequest = async (url, method, body) => {
    if (method !== 'PATCH') return null;

    const match = url?.match(/\/backend-api\/conversation\/([a-f0-9-]+)/);
    if (!match) return null;

    const threadId = match[1];

    if (body) {
      try {
        const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
        if ('is_starred' in parsedBody) {
          const startTime = performance.now();

          // Сохраняем или удаляем из starred списка
          if (parsedBody.is_starred) {
            await addStarredThread(threadId);

            // Проверяем, есть ли тред в STORE_THREADS
            if (!db) await initDB();
            const hasThread = await new Promise((resolve) => {
              const transaction = db.transaction([STORE_THREADS], 'readonly');
              const store = transaction.objectStore(STORE_THREADS);
              const request = store.get(threadId);
              request.onsuccess = () => resolve(!!request.result);
              request.onerror = () => resolve(false);
            });


            // Если треда нет, получаем данные с сервера и сохраняем
            if (!hasThread) {
              const threadData = await fetchThreadData(threadId);
              if (threadData) {
                await saveThreads([threadData]);
              } else {
                console.warn(`%c⭐ [${performance.now().toFixed(2)}ms] Failed to fetch thread data from server`, 'color: #ff9900');
              }
            }
          } else {
            await removeStarredThread(threadId);
          }

          return { threadId, isStarred: parsedBody.is_starred };
        }
      } catch (e) {
        console.error('Error handling star request:', e);
      }
    }
    return null;
  };

  // ==================== ПЕРЕХВАТ FETCH ====================

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const [resource, config] = args;
    const url = typeof resource === 'string' ? resource : resource.url;
    const method = (resource.method || config?.method || 'GET').toUpperCase();

    // Получаем body из Request объекта или config
    let body = config?.body;
    if (resource instanceof Request && !body) {
      try {
        // Клонируем Request чтобы прочитать body без его "использования"
        const clonedRequest = resource.clone();
        body = await clonedRequest.text();
      } catch (e) {
        // Если не удалось прочитать, пропускаем
      }
    }

    // Обрабатываем is_starred: сохраняем в нашу БД и пропускаем запрос к серверу,
    // чтобы приложение получило настоящий ответ и само перезапросило /pins (UI обновится).
    const starResult = await handleStarRequest(url, method, body);
    let response;

    if (starResult) {
      response = await originalFetch.apply(this, args);

      if (response.ok) {
        // Сервер вернул 200 — приложение само перезапросит /pins и получит наш дополненный ответ
        // response пойдёт в блок ниже, где перехватывается GET /pins (это другой запрос)
      } else {
        // Сервер вернул ошибку (например 404) — подменяем на 200 и триггерим обновление UI
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('chatgpt-starred-changed', {
            detail: { threadId: starResult.threadId, isStarred: starResult.isStarred }
          }));
          forceReactUpdate();
        }, 0);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (!response) {
      response = await originalFetch.apply(this, args);
    }

    // Перехватываем GET /pins - дополняем ответ сервера нашими starred тредами
    if (method === 'GET' && url?.includes('/backend-api/pins')) {
      try {
        const clonedResponse = response.clone();
        const serverData = await clonedResponse.json();

        // Получаем наши starred треды
        const starredThreads = await getStarredThreadsData();

        if (starredThreads.length > 0) {
          // Получаем ID тредов из ответа сервера
          const serverIds = new Set(
            (Array.isArray(serverData) ? serverData : [])
              .map(item => item.item?.id)
              .filter(Boolean)
          );

          // Добавляем наши треды, которых нет в ответе сервера
          const missingThreads = starredThreads
            .filter(thread => !serverIds.has(thread.id))
            .map(thread => ({
              item: thread,
              item_type: 'conversation'
            }));

          if (missingThreads.length > 0) {
            const combinedData = [
              ...(Array.isArray(serverData) ? serverData : []),
              ...missingThreads
            ];

            return new Response(
              JSON.stringify(combinedData),
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              }
            );
          }
        }
      } catch (e) {
        console.error('Error augmenting pins response:', e);
      }
    }

    // Перехватываем GET /conversations для фильтрации starred тредов
    if (method === 'GET' && url?.includes('/backend-api/conversations?')) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();

        if (data.items && Array.isArray(data.items)) {
          // Сохраняем треды в IndexedDB
          await saveThreads(data.items);

          // Получаем список starred IDs
          const starredIds = await getStarredThreadIds();
          const starredSet = new Set(starredIds);

          // Фильтруем starred треды из списка
          const filteredItems = data.items.filter(item => !starredSet.has(item.id));
          // Возвращаем модифицированный ответ
          return new Response(
            JSON.stringify({
              ...data,
              items: filteredItems,
              total: data.total - (data.items.length - filteredItems.length)
            }),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            }
          );
        }
      } catch (e) {
        console.error('Error filtering conversations:', e);
      }
    }

    if (shouldLog(url)) {
      let requestData = null;
      if (config?.body) {
        try {
          requestData = JSON.parse(config.body);
        } catch (e) {
          requestData = config.body;
        }
      }

      const clonedResponse = response.clone();
      clonedResponse.json()
        .then((data) => {
          logToConsole(
            method,
            url,
            requestData,
            data,
            Object.fromEntries(response.headers.entries()),
            response.status
          );
        })
        .catch(() => {});
    }

    return response;
  };

  // ==================== ПЕРЕХВАТ XMLHttpRequest ====================

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptorMethod = method;
    this._interceptorUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const xhr = this;

    // Проверяем синхронно, является ли это starred запросом
    const isStarRequest = xhr._interceptorMethod === 'PATCH' &&
                          xhr._interceptorUrl?.match(/\/backend-api\/conversation\/([a-f0-9-]+)/) &&
                          body && (() => {
                            try {
                              const parsed = JSON.parse(body);
                              return 'is_starred' in parsed;
                            } catch { return false; }
                          })();

    if (isStarRequest) {

      // Асинхронно обрабатываем starred запрос и ЖДЕМ завершения
      (async () => {
        await handleStarRequest(xhr._interceptorUrl, xhr._interceptorMethod, body);

        // Имитируем успешный ответ ПОСЛЕ сохранения
        Object.defineProperty(xhr, 'readyState', { writable: true, value: 4 });
        Object.defineProperty(xhr, 'status', { writable: true, value: 200 });
        Object.defineProperty(xhr, 'statusText', { writable: true, value: 'OK' });
        Object.defineProperty(xhr, 'responseText', { writable: true, value: JSON.stringify({ success: true }) });
        Object.defineProperty(xhr, 'response', { writable: true, value: JSON.stringify({ success: true }) });


        // Принудительно обновляем React UI
        setTimeout(() => {
          forceReactUpdate();
        }, 0);

        // Вызываем событие load
        xhr.dispatchEvent(new Event('load'));
        xhr.dispatchEvent(new Event('loadend'));
      })();

      return;
    }

    // Перехватываем GET /pins - дополняем ответ сервера нашими starred тредами
    if (xhr._interceptorMethod === 'GET' && xhr._interceptorUrl?.includes('/backend-api/pins')) {
      xhr.addEventListener('load', async function() {
        if (this.status >= 200 && this.status < 300) {
          try {
            const serverData = JSON.parse(this.responseText);

            // Получаем наши starred треды
            const starredThreads = await getStarredThreadsData();

            if (starredThreads.length > 0) {
              // Получаем ID тредов из ответа сервера
              const serverIds = new Set(
                (Array.isArray(serverData) ? serverData : [])
                  .map(item => item.item?.id)
                  .filter(Boolean)
              );

              // Добавляем наши треды, которых нет в ответе сервера
              const missingThreads = starredThreads
                .filter(thread => !serverIds.has(thread.id))
                .map(thread => ({
                  item: thread,
                  item_type: 'conversation'
                }));

              if (missingThreads.length > 0) {
                const combinedData = [
                  ...(Array.isArray(serverData) ? serverData : []),
                  ...missingThreads
                ];

                // Модифицируем ответ
                Object.defineProperty(this, 'responseText', {
                  writable: true,
                  value: JSON.stringify(combinedData)
                });
                Object.defineProperty(this, 'response', {
                  writable: true,
                  value: JSON.stringify(combinedData)
                });
              }
            }
          } catch (e) {
            console.error('Error augmenting pins response (XHR):', e);
          }
        }
      }, { once: false });
    }

    // Перехватываем GET /conversations для фильтрации
    if (xhr._interceptorMethod === 'GET' && xhr._interceptorUrl?.includes('/backend-api/conversations?')) {
      xhr.addEventListener('load', async function() {
        if (this.status >= 200 && this.status < 300) {
          try {
            const data = JSON.parse(this.responseText);
            if (data.items && Array.isArray(data.items)) {
              // Сохраняем треды
              await saveThreads(data.items);

              // Получаем starred IDs и фильтруем
              const starredIds = await getStarredThreadIds();
              const starredSet = new Set(starredIds);
              const filteredItems = data.items.filter(item => !starredSet.has(item.id));

              // Модифицируем ответ
              const modifiedData = {
                ...data,
                items: filteredItems,
                total: data.total - (data.items.length - filteredItems.length)
              };

              Object.defineProperty(this, 'responseText', {
                writable: true,
                value: JSON.stringify(modifiedData)
              });
              Object.defineProperty(this, 'response', {
                writable: true,
                value: JSON.stringify(modifiedData)
              });

            }
          } catch (e) {
            console.error('Error filtering XHR conversations:', e);
          }
        }
      }, { once: false });
    }

    // Логирование
    if (shouldLog(this._interceptorUrl)) {
      let requestData = null;
      if (body) {
        try {
          requestData = JSON.parse(body);
        } catch (e) {
          requestData = body;
        }
      }

      this.addEventListener('load', function() {
        if (this.status >= 200 && this.status < 300) {
          try {
            const responseData = JSON.parse(this.responseText);
            const headers = this.getAllResponseHeaders();
            logToConsole(
              this._interceptorMethod,
              this._interceptorUrl,
              requestData,
              responseData,
              headers,
              this.status
            );
          } catch (e) {}
        }
      });
    }

    return originalXHRSend.apply(this, arguments);
  };

  console.log('%c✅ ChatGPT API Interceptor активен', 'color: #10a37f; font-weight: bold');
  console.log('%c   📋 Логирование: pins, conversations', 'color: #666');
  console.log('%c   ⭐ Блокировка: is_starred запросов', 'color: #ff9900');
  console.log('%c   📌 Блокировка: /pins запросов (возврат starred тредов)', 'color: #ff6b00');
  console.log('%c   🔄 Фильтрация: starred треды скрыты из списка conversations', 'color: #0066cc');
  console.log('%c\n   Команды:', 'color: #999; font-weight: bold');
  console.log('%c   window.getStarredThreads() - показать starred треды', 'color: #999');
  console.log('%c   window.clearAllStarred() - очистить все starred треды', 'color: #999');
  console.log('%c   window.loggingOff() / loggingOn() - выкл/вкл логирование', 'color: #999');
})();
