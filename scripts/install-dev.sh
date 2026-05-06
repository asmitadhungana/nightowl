#!/bin/bash
# =============================================================================
# NightOwl v3 — Dev/Test Install Script (macOS)
#
# Builds the v3 daemon, generates a LaunchDaemon plist that points at the
# already-built dist directory (no copying or pkg bundling), and loads it.
# Defaults to NIGHTOWL_DRY_RUN=1 so the daemon fires warnings + notifications
# but DOES NOT actually halt your machine — you can verify the full flow
# safely. Pass --enforce to remove the dry-run flag.
#
# Usage:
#   bash scripts/install-dev.sh           # safe (dry-run)
#   bash scripts/install-dev.sh --enforce # actually halt on curfew
#   bash scripts/install-dev.sh --uninstall
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIST="$REPO_ROOT/packages/daemon/dist/index.js"
DAEMON_WORKING_DIR="$REPO_ROOT/packages/daemon"
PLIST_PATH="/Library/LaunchDaemons/com.nightowl.daemon.plist"
LOG_PATH="/var/log/nightowl.log"
DATA_PATH="$HOME/Library/Application Support/NightOwl"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

# ---------- Uninstall ----------
if [[ "${1:-}" == "--uninstall" ]]; then
    [[ $EUID -eq 0 ]] || die "Re-run with sudo: sudo bash scripts/install-dev.sh --uninstall"
    launchctl unload -w "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    info "NightOwl daemon uninstalled. Logs preserved at $LOG_PATH."
    exit 0
fi

# ---------- Pre-flight ----------
[[ "$(uname)" == "Darwin" ]] || die "This script only supports macOS."
[[ $EUID -eq 0 ]] || die "Re-run with sudo: sudo bash scripts/install-dev.sh"
[[ -n "${SUDO_USER:-}" ]] || die "SUDO_USER not set — invoke via sudo, not as root login."

# Resolve the actual user (not root) so the plist captures the right identity.
TARGET_USER="$SUDO_USER"
TARGET_HOME="$(eval echo "~$TARGET_USER")"
DATA_PATH="$TARGET_HOME/Library/Application Support/NightOwl"

# Find node binary as TARGET_USER (their PATH is what matters)
NODE_BIN="$(sudo -u "$TARGET_USER" which node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [[ -x "$candidate" ]]; then
            NODE_BIN="$candidate"
            break
        fi
    done
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "Could not find node. Install Node 18+ via Homebrew first."
info "node:        $NODE_BIN"

# Build the daemon (as the user, not root)
if [[ ! -f "$DAEMON_DIST" ]]; then
    info "Building daemon..."
    sudo -u "$TARGET_USER" bash -c "cd '$REPO_ROOT' && npm install && npm run build:shared && npm run build:daemon" \
        || die "Build failed. Run 'npm install && npm run build' manually as your user."
fi
[[ -f "$DAEMON_DIST" ]] || die "Built daemon not found at $DAEMON_DIST"
info "daemon:      $DAEMON_DIST"

# Determine dry-run flag
DRY_RUN_KV=""
DRY_RUN_HUMAN="DRY-RUN (warnings + notifications, no halt)"
if [[ "${1:-}" == "--enforce" ]]; then
    DRY_RUN_HUMAN="ENFORCING (will actually halt the computer on curfew!)"
    warn "Running in ENFORCE mode. The daemon WILL halt your computer at curfew."
    read -p "Type 'yes' to confirm: " confirm
    [[ "$confirm" == "yes" ]] || die "Aborted."
else
    DRY_RUN_KV="<key>NIGHTOWL_DRY_RUN</key><string>1</string>"
fi
info "mode:        $DRY_RUN_HUMAN"
info "user:        $TARGET_USER"
info "data path:   $DATA_PATH"

# Ensure data dir exists, owned by user
sudo -u "$TARGET_USER" mkdir -p "$DATA_PATH"

# Ensure log file exists & is appendable
touch "$LOG_PATH"
chmod 644 "$LOG_PATH"

# ---------- Generate plist ----------
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nightowl.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DAEMON_DIST</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DAEMON_WORKING_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NIGHTOWL_DATA_PATH</key>
        <string>$DATA_PATH</string>
        <key>NIGHTOWL_USER</key>
        <string>$TARGET_USER</string>
        $DRY_RUN_KV
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_PATH</string>
    <key>StandardErrorPath</key>
    <string>$LOG_PATH</string>
</dict>
</plist>
PLIST
chmod 644 "$PLIST_PATH"
info "plist:       $PLIST_PATH"

# ---------- Load ----------
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"
info "Daemon loaded."

echo
echo -e "${CYAN}============== NEXT STEPS ==============${NC}"
echo "1. Watch the log:    tail -f $LOG_PATH"
echo "2. Check it's alive: launchctl list | grep com.nightowl"
echo "3. Drop a test schedule into '$DATA_PATH/schedule.json' (see scripts/test-schedule.json)"
echo "4. To uninstall:     sudo bash scripts/install-dev.sh --uninstall"
echo
echo "Mode: $DRY_RUN_HUMAN"
