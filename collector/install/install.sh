#!/bin/sh
# Installs the collector as a per-user LaunchAgent (npm run install-agent).
# Run only when the owner says so (HARNESS.md §1). Re-running replaces the installed copy.
# Uninstall: launchctl bootout gui/$(id -u)/com.mhilo.agents-collector
#            rm ~/Library/LaunchAgents/com.mhilo.agents-collector.plist
set -eu

LABEL=com.mhilo.agents-collector
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE=$(command -v node || true)
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/mhilo-agents"
DOMAIN="gui/$(id -u)"

if [ -z "$NODE" ]; then
  echo "install-agent: node not found on PATH" >&2
  exit 1
fi
case "$REPO" in
  */.claude/worktrees/*) echo "install-agent: refusing to install from an agent worktree ($REPO); run it from the main checkout" >&2; exit 1 ;;
  *'|'*|*'&'*) echo "install-agent: repo path contains | or &, which this script cannot substitute" >&2; exit 1 ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$HERE/$LABEL.plist" > "$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"

# Replace a running copy, then load.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
launchctl enable "$DOMAIN/$LABEL"

echo "installed $LABEL"
echo "  node:  $NODE"
echo "  repo:  $REPO"
echo "  logs:  $LOGS/collector.log"
echo "  view:  http://127.0.0.1:8777/"
