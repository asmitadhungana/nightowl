#!/bin/bash
# =============================================================================
# NightOwl Daemon (nightowld) v2
# Reads schedule from schedule.json, enforces per-day curfew.
# Runs as root via launchd.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEDULE_FILE="${NIGHTOWL_SCHEDULE:-$SCRIPT_DIR/schedule.json}"
FOCUS_FILE="${NIGHTOWL_FOCUS:-$SCRIPT_DIR/focus.json}"
LOG_FILE="/var/log/nightowl.log"
TEST_MODE="${NIGHTOWL_TEST_MODE:-0}"
NTP_SERVER="pool.ntp.org"
TARGET_USER="${NIGHTOWL_USER:-asmeedhungana}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    if [[ -w "$LOG_FILE" ]] || [[ -w "$(dirname "$LOG_FILE")" ]]; then
        echo "[$timestamp] nightowld: $*" >> "$LOG_FILE"
    else
        echo "[$timestamp] nightowld: $*"
    fi
}

# ---------------------------------------------------------------------------
# Check Focus Mode (instant mini-curfew)
# ---------------------------------------------------------------------------
is_focus_active() {
    [[ -f "$FOCUS_FILE" ]] || return 1

    local result
    result=$(python3 -c "
import json, datetime
f = json.load(open('$FOCUS_FILE'))
if not f.get('active'):
    print('inactive')
else:
    end = datetime.datetime.fromisoformat(f['endTime'].replace('Z','+00:00'))
    print('active' if datetime.datetime.now(datetime.timezone.utc) < end else 'expired')
" 2>/dev/null)
    [[ "$result" == "active" ]]
}

get_focus_remaining() {
    python3 -c "
import json, datetime
f = json.load(open('$FOCUS_FILE'))
end = datetime.datetime.fromisoformat(f['endTime'].replace('Z','+00:00'))
now = datetime.datetime.now(datetime.timezone.utc)
remaining = int((end - now).total_seconds())
print(max(0, remaining))
" 2>/dev/null || echo "0"
}

# ---------------------------------------------------------------------------
# File ownership management
# ---------------------------------------------------------------------------
lock_schedule_file() {
    if [[ "$EUID" -eq 0 ]] && [[ -f "$SCHEDULE_FILE" ]]; then
        local current_owner
        current_owner=$(stat -f "%Su" "$SCHEDULE_FILE" 2>/dev/null || stat -c "%U" "$SCHEDULE_FILE" 2>/dev/null)
        if [[ "$current_owner" != "root" ]]; then
            chown root:wheel "$SCHEDULE_FILE" 2>/dev/null || true
            chmod 644 "$SCHEDULE_FILE" 2>/dev/null || true
            log "Locked schedule file (now owned by root)"
        fi
    fi
}

unlock_schedule_file() {
    if [[ "$EUID" -eq 0 ]] && [[ -f "$SCHEDULE_FILE" ]]; then
        local current_owner user_to_restore
        current_owner=$(stat -f "%Su" "$SCHEDULE_FILE" 2>/dev/null || stat -c "%U" "$SCHEDULE_FILE" 2>/dev/null)
        # Get user from schedule or fall back to TARGET_USER or default
        user_to_restore=$(python3 -c "import json; print(json.load(open('$SCHEDULE_FILE')).get('user', 'asmeedhungana'))" 2>/dev/null || echo "${TARGET_USER:-asmeedhungana}")
        if [[ "$current_owner" == "root" ]]; then
            chown "$user_to_restore:staff" "$SCHEDULE_FILE" 2>/dev/null || true
            chmod 644 "$SCHEDULE_FILE" 2>/dev/null || true
            log "Unlocked schedule file (restored ownership to $user_to_restore)"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Read schedule.json via python3
# ---------------------------------------------------------------------------
read_schedule() {
    if [[ ! -f "$SCHEDULE_FILE" ]]; then
        log "No schedule file found at $SCHEDULE_FILE — daemon idle"
        return 1
    fi

    SCHEDULE_ACTIVE=$(python3 -c "import json; s=json.load(open('$SCHEDULE_FILE')); print('true' if s.get('active') else 'false')")
    if [[ "$SCHEDULE_ACTIVE" != "true" ]]; then
        # Schedule not active - ensure file is unlocked
        unlock_schedule_file
        return 1
    fi

    # Check lock end date
    local lock_expired
    lock_expired=$(python3 -c "
import json, datetime
s = json.load(open('$SCHEDULE_FILE'))
end = s.get('lockEndDate')
if not end:
    print('true')
else:
    print('true' if datetime.datetime.fromisoformat(end.replace('Z','+00:00')) < datetime.datetime.now(datetime.timezone.utc) else 'false')
")
    if [[ "$lock_expired" == "true" ]]; then
        log "Lock period expired — daemon idle"
        # Lock expired - restore user ownership
        unlock_schedule_file
        return 1
    fi

    # Active lock - ensure file is locked to root
    lock_schedule_file

    CURFEW_TZ=$(python3 -c "import json; print(json.load(open('$SCHEDULE_FILE')).get('timezone','Asia/Kathmandu'))")

    # Get today's day name and curfew times
    local day_info
    day_info=$(python3 -c "
import json, os, time
os.environ['TZ'] = '$(echo $CURFEW_TZ)'
time.tzset()
from datetime import datetime
s = json.load(open('$SCHEDULE_FILE'))
day = datetime.now().strftime('%A').lower()
d = s['days'].get(day, {})
print(d.get('curfewStart','22:00') + ' ' + d.get('curfewEnd','06:00'))
")
    CURFEW_START=$(echo "$day_info" | awk '{print $1}')
    CURFEW_END=$(echo "$day_info" | awk '{print $2}')
    TARGET_USER=$(python3 -c "
import json
s = json.load(open('$SCHEDULE_FILE'))
print(s.get('user', 'asmeedhungana'))
" 2>/dev/null || echo "asmeedhungana")

    return 0
}

# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
get_current_minutes() {
    TZ="$CURFEW_TZ" python3 -c "
import os, time
os.environ['TZ'] = '$CURFEW_TZ'
time.tzset()
from datetime import datetime
dt = datetime.now()
print(dt.hour * 60 + dt.minute)
"
}

get_current_hhmm() {
    TZ="$CURFEW_TZ" python3 -c "
import os, time
os.environ['TZ'] = '$CURFEW_TZ'
time.tzset()
from datetime import datetime
print(datetime.now().strftime('%H:%M'))
"
}

is_curfew() {
    local current_min="$1"
    local start_h="${CURFEW_START%%:*}" start_m="${CURFEW_START##*:}"
    local end_h="${CURFEW_END%%:*}" end_m="${CURFEW_END##*:}"
    start_h=$((10#$start_h)); start_m=$((10#$start_m))
    end_h=$((10#$end_h)); end_m=$((10#$end_m))
    local start_min=$(( start_h * 60 + start_m ))
    local end_min=$(( end_h * 60 + end_m ))

    if (( start_min > end_min )); then
        (( current_min >= start_min || current_min < end_min )) && return 0
    else
        (( current_min >= start_min && current_min < end_min )) && return 0
    fi
    return 1
}

# ---------------------------------------------------------------------------
# macOS Notifications
# ---------------------------------------------------------------------------
notify() {
    local title="$1"
    local message="$2"
    # Run as the target user so notification appears on their screen
    sudo -u "$TARGET_USER" osascript -e "display notification \"$message\" with title \"$title\" sound name \"Submarine\"" 2>/dev/null || true
    log "Notification: $title - $message"
}

# ---------------------------------------------------------------------------
# Enforce curfew
# Args: $1 = "immediate" for no warnings (used by Focus Mode)
# ---------------------------------------------------------------------------
enforce_curfew() {
    local mode="${1:-normal}"
    log "=== CURFEW ENFORCEMENT ($mode) ==="

    if [[ "$TEST_MODE" == "1" ]]; then
        if [[ "$mode" == "immediate" ]]; then
            log "[TEST MODE] IMMEDIATE shutdown (Focus Mode)"
        else
            log "[TEST MODE] Would send 2-minute warning"
            log "[TEST MODE] Would wait 90 seconds"
            log "[TEST MODE] Would send 30-second warning"
            log "[TEST MODE] Would wait 30 seconds"
        fi
        log "[TEST MODE] Would kill processes and shutdown"
        sleep 5
        return
    fi

    if [[ "$mode" == "immediate" ]]; then
        # Focus Mode: immediate enforcement, no waiting
        notify "🦉 NightOwl - FOCUS MODE" "Locking down NOW. See you when it's over."
        sleep 3
    else
        # Regular curfew: 2-minute warning
        notify "🦉 NightOwl" "Computer will shut down in 2 minutes. Save your work!"
        log "Sent 2-minute warning"
        sleep 90

        # T-30 seconds warning
        notify "🦉 NightOwl - FINAL WARNING" "Shutting down in 30 seconds..."
        log "Sent 30-second warning"
        sleep 30
    fi

    # Enforce
    log "Force-killing all processes for user: $TARGET_USER"
    killall -u "$TARGET_USER" -9 2>/dev/null || true
    sleep 1
    killall -u "$TARGET_USER" -9 2>/dev/null || true
    sleep 1
    pkill -9 -u "$TARGET_USER" 2>/dev/null || true
    sleep 1

    log "Initiating system shutdown"
    halt -q 2>/dev/null || shutdown -h now 2>/dev/null || true
    sleep 3
    /sbin/halt -q 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
main() {
    log "=========================================="
    log "NightOwl daemon v2 starting (PID: $$)"
    log "=========================================="

    if [[ "$TEST_MODE" == "1" ]]; then
        log "*** TEST MODE ACTIVE ***"
    fi

    while true; do
        # Check Focus Mode first (instant mini-curfew)
        if is_focus_active; then
            local remaining
            remaining=$(get_focus_remaining)
            log "FOCUS MODE: $remaining seconds remaining"
            enforce_curfew "immediate"
            sleep 10
            continue
        fi

        # Check regular schedule
        if ! read_schedule; then
            sleep 60
            continue
        fi

        local current_min current_hhmm
        current_min=$(get_current_minutes)
        current_hhmm=$(get_current_hhmm)

        log "Time: ${current_hhmm} ${CURFEW_TZ} | Curfew: ${CURFEW_START}-${CURFEW_END}"

        if is_curfew "$current_min"; then
            enforce_curfew
            sleep 30
        else
            sleep 60
        fi
    done
}

main "$@"
