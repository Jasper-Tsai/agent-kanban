#!/usr/bin/env bash
# Copy the SessionStart inbox hook to a configurable installation directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${KB_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"
cp "$ROOT/scripts/hooks/kanban-inbox-hook.mjs" "$DEST/kanban-inbox-hook"
chmod +x "$DEST/kanban-inbox-hook"
echo "Installed $DEST/kanban-inbox-hook"
echo "Add it to your Claude Code or Codex SessionStart hook configuration."
