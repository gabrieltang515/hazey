#!/bin/sh
set -eu
HAZEY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$HAZEY_ROOT"
if command -v node >/dev/null 2>&1; then
  HAZEY_NODE=$(command -v node)
elif [ -x /Applications/Cursor.app/Contents/Resources/app/resources/helpers/node ]; then
  HAZEY_NODE=/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node
else
  printf '%s\n' 'Install Node.js 22.13 or newer first.' >&2
  exit 1
fi
if [ "${1:-}" = "telegram" ]; then
  shift
  exec "$HAZEY_NODE" scripts/setup-telegram.js "$@"
elif [ "${1:-}" = "test" ]; then
  shift
  exec "$HAZEY_NODE" --test "$@"
elif [ "${1:-}" = "browser" ]; then
  shift
  exec "$HAZEY_NODE" scripts/check-browser.js "$@"
else
  exec "$HAZEY_NODE" node_modules/wrangler/bin/wrangler.js "$@"
fi
