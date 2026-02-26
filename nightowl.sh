#!/bin/bash
# =============================================================================
# NightOwl CLI v2
# Usage: nightowl {install|uninstall|status|ui|test}
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="/etc/nightowl/config.json"
SCHEDULE_FILE="$SCRIPT_DIR/schedule.json"
PLIST_FILE="/Library/LaunchDaemons/com.nightowl.daemon.plist"
PLIST_WEB="/Library/LaunchDaemons/com.nightowl.web.plist"
DAEMON_BIN="/usr/local/bin/nightowld"
CLI_BIN="/usr/local/bin/nightowl"
LOCK_PW_FILE="$SCRIPT_DIR/.lock-password"
WEB_PORT=8899

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

die() { echo -e "${RED}Error: $*${NC}" >&2; exit 1; }
info() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

require_root() {
    [[ $EUID -eq 0 ]] || die "This command must be run as root (use sudo)"
}

verify_password() {
    local prompt="${1:-Enter lock password: }"
    [[ -f "$LOCK_PW_FILE" ]] || die "Lock password file not found"
    read -rsp "$prompt" password
    echo

    # Verify password via server API (bcrypt comparison)
    local response
    response=$(curl -s -X POST http://localhost:${WEB_PORT}/api/verify-password \
        -H "Content-Type: application/json" \
        -d "{\"password\": \"$password\"}" 2>/dev/null)

    if [[ -z "$response" ]]; then
        # Server not running - fall back to Node.js direct verification
        local result
        result=$(node -e "
const bcrypt = require('bcrypt');
const fs = require('fs');
const hash = fs.readFileSync('$LOCK_PW_FILE', 'utf8').trim();
bcrypt.compare('$password', hash).then(r => console.log(r ? 'true' : 'false'));
" 2>/dev/null)
        [[ "$result" == "true" ]] || die "Incorrect password"
    else
        local valid
        valid=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('valid', False))" 2>/dev/null)
        [[ "$valid" == "True" ]] || die "Incorrect password"
    fi
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
cmd_status() {
    echo -e "${BOLD}NightOwl Status${NC}"
    echo "==============="

    if [[ ! -f "$SCHEDULE_FILE" ]]; then
        echo -e "Schedule: ${YELLOW}Not configured${NC}"
        echo -e "Web UI:   http://localhost:${WEB_PORT}"
        return
    fi

    local active
    active=$(python3 -c "import json; s=json.load(open('$SCHEDULE_FILE')); print('true' if s.get('active') else 'false')")

    if [[ "$active" == "true" ]]; then
        echo -e "Status:   ${RED}LOCKED${NC}"
        python3 -c "
import json
from datetime import datetime
s = json.load(open('$SCHEDULE_FILE'))
end = datetime.fromisoformat(s['lockEndDate'].replace('Z','+00:00'))
start = datetime.fromisoformat(s['lockStartDate'].replace('Z','+00:00'))
days = s.get('lockPeriodDays', '?')
print(f\"Lock:     {days} days (until {end.strftime('%Y-%m-%d')})\")
print(f\"Timezone: {s['timezone']}\")
print()
import os, time
os.environ['TZ'] = s['timezone']
time.tzset()
now = datetime.now()
day = now.strftime('%A').lower()
d = s['days'].get(day, {})
print(f\"Today:    {day.title()}\")
print(f\"Curfew:   {d.get('curfewStart','?')} - {d.get('curfewEnd','?')}\")
print(f\"Now:      {now.strftime('%H:%M')}\")
"
    else
        echo -e "Status:   ${GREEN}Inactive${NC} (no active schedule)"
    fi

    echo
    echo -e "Web UI:   ${CYAN}http://localhost:${WEB_PORT}${NC}"
}

# ---------------------------------------------------------------------------
# ui
# ---------------------------------------------------------------------------
cmd_ui() {
    local url="http://localhost:${WEB_PORT}"
    echo "Opening $url ..."
    if command -v open &>/dev/null; then
        open "$url"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$url"
    else
        echo "Visit: $url"
    fi
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
cmd_install() {
    require_root
    echo -e "${BOLD}NightOwl v2 Installer${NC}"
    echo

    # Install node deps
    if [[ -f "$SCRIPT_DIR/package.json" ]]; then
        cd "$SCRIPT_DIR"
        npm install --production 2>/dev/null || warn "npm install failed — install manually"
    fi

    # Copy daemon
    cp "$SCRIPT_DIR/nightowld.sh" "$DAEMON_BIN"
    chmod 755 "$DAEMON_BIN"
    info "Daemon installed"

    # Copy CLI
    cp "$SCRIPT_DIR/nightowl.sh" "$CLI_BIN"
    chmod 755 "$CLI_BIN"
    info "CLI installed"

    # Daemon plist
    cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nightowl.daemon</string>
    <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DAEMON_BIN</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>EnvironmentVariables</key><dict>
        <key>NIGHTOWL_SCHEDULE</key><string>$SCRIPT_DIR/schedule.json</string>
    </dict>
</dict>
</plist>
PLIST
    info "Daemon LaunchDaemon created"

    # Web server plist
    cat > "$PLIST_WEB" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nightowl.web</string>
    <key>ProgramArguments</key><array><string>$(which node)</string><string>$SCRIPT_DIR/server.js</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>WorkingDirectory</key><string>$SCRIPT_DIR</string>
</dict>
</plist>
PLIST
    info "Web server LaunchDaemon created"

    launchctl load "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_WEB" 2>/dev/null || true
    info "Services loaded"

    echo
    echo -e "${BOLD}NightOwl v2 installed.${NC}"
    echo -e "Web UI: ${CYAN}http://localhost:${WEB_PORT}${NC}"
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------
cmd_uninstall() {
    require_root
    verify_password "Enter lock password to uninstall: "

    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl unload "$PLIST_WEB" 2>/dev/null || true
    rm -f "$DAEMON_BIN" "$CLI_BIN" "$PLIST_FILE" "$PLIST_WEB"
    info "NightOwl uninstalled"
}

# ---------------------------------------------------------------------------
# test
# ---------------------------------------------------------------------------
cmd_test() {
    echo -e "${BOLD}NightOwl Test Mode${NC}"
    export NIGHTOWL_TEST_MODE=1
    export NIGHTOWL_SCHEDULE="$SCHEDULE_FILE"
    # Run daemon in background and kill after 30 seconds (macOS doesn't have timeout)
    bash "$SCRIPT_DIR/nightowld.sh" 2>&1 &
    local pid=$!
    sleep 30
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    echo "Test complete."
}

# ---------------------------------------------------------------------------
case "${1:-}" in
    install)    cmd_install ;;
    uninstall)  cmd_uninstall ;;
    status)     cmd_status ;;
    ui)         cmd_ui ;;
    test)       cmd_test ;;
    *)
        echo "NightOwl v2 — Sleep Curfew Enforcer"
        echo
        echo "Usage: nightowl <command>"
        echo
        echo "  install     Install daemon and web server"
        echo "  uninstall   Remove everything (requires password)"
        echo "  status      Show schedule and curfew status"
        echo "  ui          Open the web UI in browser"
        echo "  test        Run daemon in test mode (30s)"
        ;;
esac
