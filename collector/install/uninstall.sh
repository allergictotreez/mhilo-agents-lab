#!/bin/sh
# Removes the collector's LaunchAgent (npm run uninstall-agent). The repo, your lab configs, the logs
# in ~/Library/Logs/mhilo-agents and anything in ~/.config/mhilo-agents are left as they are.
set -eu

LABEL=com.mhilo.agents-collector
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ -f "$DEST" ]; then
  rm "$DEST"
  echo "removed $LABEL: the collector no longer starts at login"
else
  echo "$LABEL was not installed; nothing to remove"
fi
