#!/bin/bash
# =============================================================================
# NightOwl Daemon (nightowld) v2
# Reads schedule from schedule.json, enforces per-day curfew.
# Runs as root via launchd.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEDULE_FILE="${NIGHTOWL_SCHEDULE:-$SCRIPT_DIR/schedule.json}"
LOG_FILE="/var/log/nightowl.log"
TEST_MODE="${NIGHTOWL_TEST_MODE:-0}"
NTP_SERVER="pool.ntp.org"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[$timestamp] nightowld: $*" >> "$LOG_FILE" 2>/dev/null || echo "[$timestamp] nightowld: $*"
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
        return 1
    fi

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
# Enforce curfew
# ---------------------------------------------------------------------------
enforce_curfew() {
    log "=== CURFEW ENFORCEMENT ==="
    log "Force-killing all processes for user: $TARGET_USER"

    if [[ "$TEST_MODE" == "1" ]]; then
        log "[TEST MODE] Would kill and shutdown"
        sleep 30
        return
    fi

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
