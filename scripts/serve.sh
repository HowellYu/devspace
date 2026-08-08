#!/usr/bin/env bash
# DevSpace server launcher for the Luna fork.
#
# Sets the ChatGPT/Luna environment and starts the server in the foreground.
# Works from any directory; Ctrl+C stops the server.
#
#   scripts/serve.sh
#
# Any of the three env vars below can be overridden by exporting it before
# running the script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export DEVSPACE_WIDGETS="${DEVSPACE_WIDGETS:-changes}"
export DEVSPACE_TOOL_MODE="${DEVSPACE_TOOL_MODE:-minimal}"
export LUNA_COMMAND="${LUNA_COMMAND:-$HOME/.kimi-code/bin/kimi}"

if [ ! -f dist/cli.js ]; then
  echo "error: dist/cli.js is missing — run: npm run build" >&2
  exit 1
fi

if [ ! -x "$LUNA_COMMAND" ]; then
  echo "error: Luna CLI is not an executable file: $LUNA_COMMAND" >&2
  echo "       check the path for typos, or set LUNA_COMMAND to the" >&2
  echo "       location of the kimi binary (default: ~/.kimi-code/bin/kimi)" >&2
  exit 1
fi

exec node dist/cli.js serve "$@"
