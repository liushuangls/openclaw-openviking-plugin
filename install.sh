#!/usr/bin/env bash
# Install openclaw-openviking-plugin into the local OpenClaw instance.
# Usage:
#   ./install.sh                        # install with defaults
#   OV_BASE_URL=http://my-server:1934 ./install.sh

set -euo pipefail

PLUGIN_ID="openclaw-openviking-plugin"
PLUGIN_SRC="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
EXTENSIONS_DIR="$OPENCLAW_DIR/extensions/$PLUGIN_ID"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"

OV_BASE_URL="${OV_BASE_URL:-http://127.0.0.1:1934}"

if [ -d "$EXTENSIONS_DIR" ]; then
  MODE="update"
  echo "→ Updating $PLUGIN_ID..."
else
  MODE="install"
  echo "→ Installing $PLUGIN_ID..."
fi

# 1. Copy plugin files (exclude tests, node_modules, .git)
rm -rf "$EXTENSIONS_DIR"
mkdir -p "$EXTENSIONS_DIR"
rsync -a --exclude=tests --exclude=node_modules --exclude=.git --exclude='*.sh' \
  "$PLUGIN_SRC/" "$EXTENSIONS_DIR/"

# 2. Install production dependencies
cd "$EXTENSIONS_DIR"
npm install --omit=dev --silent
echo "  ✓ Dependencies installed"

# 3. Update openclaw.json (only on fresh install)
if [ "$MODE" = "install" ]; then
  python3 - <<PYEOF
import json, sys

with open("$CONFIG_FILE") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
allow = plugins.setdefault("allow", [])
entries = plugins.setdefault("entries", {})

if "$PLUGIN_ID" not in allow:
    allow.append("$PLUGIN_ID")

if "$PLUGIN_ID" not in entries:
    entries["$PLUGIN_ID"] = {
        "enabled": True,
        "config": {
            "baseUrl": "$OV_BASE_URL",
            "autoRecall": True,
            "autoCapture": True,
            "recallLimit": 6,
            "recallScoreThreshold": 0.15,
            "recallTokenBudget": 2000
        }
    }

with open("$CONFIG_FILE", "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print("  ✓ openclaw.json updated")
PYEOF
else
  echo "  ✓ openclaw.json unchanged (update mode)"
fi

# 4. Restart gateway
echo "→ Restarting OpenClaw gateway..."
openclaw gateway restart 2>/dev/null || true

if [ "$MODE" = "install" ]; then
  echo "✓ Done. Plugin '$PLUGIN_ID' installed and enabled."
  echo "  OV server: $OV_BASE_URL"
else
  echo "✓ Done. Plugin '$PLUGIN_ID' updated."
fi
