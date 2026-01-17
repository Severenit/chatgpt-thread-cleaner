#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT="chatgpt-thread-cleaner-webstore.zip"

rm -f "$OUT"

# Собираем архив для Chrome Web Store из текущей папки.
# Исключаем мусор и сам архив.
zip -r "$OUT" . \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "$OUT" \
  -x "chatgpt-dom-cleaner-webstore.zip"

echo "Created: $ROOT_DIR/$OUT"

