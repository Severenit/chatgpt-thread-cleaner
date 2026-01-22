<p align="center">
  <img src="logo.png" width="256" height="256" alt="ChatGPT Thread Cleaner logo" />
</p>

# ChatGPT Thread Cleaner

Lightens long ChatGPT threads: removes old messages from the DOM, keeping the last N (default: 4) — Chrome stays fast even on huge conversations.

## Features

- Cleans message DOM **only within the current conversation** (scoped to `main`)
- Keeps **the last N** messages (default: 4)
- Triggers:
  - a button in ChatGPT UI (**only shown if messages > N**)
  - extension popup
  - context menu item
- No network requests / analytics — everything is local

## Supported domains

- `chatgpt.com`
- `chat.openai.com`

## Installation (Load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the project folder (where `manifest.json` is)

## Usage

- **ChatGPT UI button**: `Lighten chat`
- **Popup**: set `Keep last messages` → click `Clean DOM`
- **Context menu**: right click page → `Clean chat DOM nodes (keep N)`

## How it works

- Messages are located via `article[data-testid^="conversation-turn"]`.
- If markup changes — fallback to `article`.
- In any case, search and removal are scoped to `main` to avoid touching unrelated `article` elements outside the conversation.

## Build a zip for Chrome Web Store

```bash
npm run build:zip
```

The archive will appear in the project root with the version from `manifest.json`, e.g.:
- `chatgpt-thread-cleaner-webstore-v0.1.0.zip`

## Internationalization (i18n)

- Default locale: **English** (`default_locale: "en"` in `manifest.json`)
- UI strings are localized via `chrome.i18n` and live in `/_locales/*/messages.json` (currently `en` and `ru`).

## Privacy

See `PRIVACY.md`.
