#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(python3 - <<'PY'
import json
with open("manifest.json", "r", encoding="utf-8") as f:
  print(json.load(f)["version"])
PY
)"

OUT="chatgpt-thread-cleaner-webstore-v${VERSION}.zip"

rm -f "$OUT"

# Собираем архив для Chrome Web Store из текущей папки.
# Исключаем мусор и сам архив.
zip -r "$OUT" . \
  -x ".git/*" \
  -x ".git/**" \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "*.zip" \
  -x "$OUT" \
  -x "chatgpt-dom-cleaner-webstore.zip"

echo "Created: $ROOT_DIR/$OUT"

