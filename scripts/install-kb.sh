#!/usr/bin/env bash
# Copy the kb CLI to a configurable installation directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${KB_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"
cp "$ROOT/cli/kb.mjs" "$DEST/kb"
chmod +x "$DEST/kb"
echo "Installed $DEST/kb"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add $DEST to PATH to use kb." ;; esac
CONFIG_DIR="${KB_CONFIG_DIR:-$HOME/.config/agent-kanban}"
CONF="${KB_CONFIG:-$CONFIG_DIR/config.json}"
if [ ! -f "$CONF" ]; then
  echo "Config file not found: $CONF"
  echo 'Example: { "url": "https://kanban.example.com", "tokens": { "codex": "<token>", "claude": "<token>" } }'
  echo "Create the file and set its permissions to 600."
fi
