#!/usr/bin/env bash
# Install the dispatcher as a configurable macOS launchd agent.
# Usage:
#   scripts/install-dispatcher.sh              Install and start
#   scripts/install-dispatcher.sh --print      Render the plist without writing files or calling launchctl
#   scripts/install-dispatcher.sh --uninstall  Stop and remove the installed plist and executable
# Directories can be overridden with KB_INSTALL_DIR, KB_LAUNCH_AGENT_DIR, KB_LOG_DIR, and KB_STATE_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.example.agent-kanban-dispatcher"
BIN_DIR="${KB_INSTALL_DIR:-$HOME/.local/bin}"
LAUNCH_AGENT_DIR="${KB_LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${KB_LOG_DIR:-$HOME/.local/state/agent-kanban/logs}"
STATE_DIR="${KB_STATE_DIR:-$HOME/.local/state/agent-kanban}"
DEST="$BIN_DIR/kanban-dispatcher"
PLIST="$LAUNCH_AGENT_DIR/$LABEL.plist"
TEMPLATE="$ROOT/dispatcher/$LABEL.plist.template"
MODE="${1:-install}"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "Node.js was not found on PATH." >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node.js 24 or newer is required (found $($NODE_BIN -v))." >&2; exit 1; }

build_path() {
  local dirs=() p d seen=":"
  for tool in node codex claude; do
    p="$(command -v "$tool" || true)"
    [ -n "$p" ] && dirs+=("$(dirname "$p")")
  done
  dirs+=("$BIN_DIR" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin)
  local out=""
  for d in "${dirs[@]}"; do
    case "$seen" in *":$d:"*) continue ;; esac
    seen="$seen$d:"
    out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}

render_plist() {
  local path_value; path_value="$(build_path)"
  sed -e "s#@NODE@#$NODE_BIN#g" \
      -e "s#@DISPATCHER@#$DEST#g" \
      -e "s#@HOME@#$HOME#g" \
      -e "s#@PATH@#$path_value#g" \
      -e "s#@LAUNCH_AGENT_DIR@#$LAUNCH_AGENT_DIR#g" \
      -e "s#@LOG_DIR@#$LOG_DIR#g" \
      -e "s#@STATE_DIR@#$STATE_DIR#g" \
      "$TEMPLATE"
}

case "$MODE" in
  --print)
    render_plist
    ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$DEST"
    echo "Removed $PLIST and $DEST. Config, state, and logs were kept."
    ;;
  install)
    mkdir -p "$BIN_DIR" "$LAUNCH_AGENT_DIR" "$LOG_DIR" "$STATE_DIR"
    cp "$ROOT/dispatcher/kanban-dispatcher.mjs" "$DEST"
    chmod +x "$DEST"
    render_plist > "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed and started $LABEL"
    echo "  Executable: $DEST"
    echo "  Plist: $PLIST"
    echo "  Log: $LOG_DIR/agent-kanban-dispatcher.log"
    echo "  Stop with: scripts/install-dispatcher.sh --uninstall"
    ;;
  *)
    echo "Usage: $0 [--print|--uninstall]" >&2
    exit 1
    ;;
esac
