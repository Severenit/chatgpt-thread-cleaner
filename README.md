<p align="center">
  <img src="logo.png" width="256" height="256" alt="ChatGPT Thread Cleaner logo" />
</p>

# ChatGPT Thread Cleaner

Разгружает длинные переписки в ChatGPT: удаляет старые сообщения из DOM, оставляя последние 3 — Chrome перестаёт лагать на огромных тредах.

## Фичи

- Очищает DOM сообщений **только в рамках диалога** (внутри `main`)
- Оставляет **последние 3** сообщения
- Триггеры:
  - кнопка в UI ChatGPT (**появляется только если сообщений > 3**)
  - popup расширения
  - пункт в контекстном меню
- Никаких сетевых запросов/аналитики — всё локально

## Поддерживаемые домены

- `chatgpt.com`
- `chat.openai.com`

## Установка (Load unpacked)

1. Открой `chrome://extensions`
2. Включи **Developer mode**
3. Нажми **Load unpacked**
4. Выбери папку проекта (где лежит `manifest.json`)

## Использование

- **Кнопка в интерфейсе ChatGPT**: `Разгрузить чат`
- **Popup**: иконка расширения → `Очистить DOM (оставить 3)`
- **Контекстное меню**: ПКМ по странице → `Очистить DOM узлы в чате (оставить 3)`

## Как это работает

- Сообщения ищутся по `article[data-testid^="conversation-turn"]`.
- Если разметка поменялась — fallback на `article`.
- В любом случае поиск и удаление ограничены `main`, чтобы не снести “лишние” `article` вне диалога.

## Сборка zip для Chrome Web Store

```bash
npm run build:zip
```

Архив появится в корне проекта с версией из `manifest.json`, например:
- `chatgpt-thread-cleaner-webstore-v0.1.0.zip`

## Privacy

См. `PRIVACY.md`.
