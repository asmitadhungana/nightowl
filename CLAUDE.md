# CLAUDE.md — NightOwl 🦉

## Project Overview

NightOwl is a macOS device curfew system that enforces a shutdown schedule. It runs a root-level daemon (`nightowld`) that shuts down the computer during curfew hours. It also includes a web UI (Express server on port 8899) for configuring schedules and a CLI tool.

**Target OS:** macOS (Apple Silicon / Intel)
**Runtime:** Node.js (server), Bash (daemon + CLI)
**User:** This is a personal project for a single user (`asmeedhungana` macOS username)

## Architecture

```
nightowl/
├── server.js          # Express web server (port 8899) — config UI + API
├── nightowld.sh       # Root daemon — reads schedule.json, enforces curfew via shutdown
├── nightowl.sh        # CLI tool — install/uninstall/status/test
├── install.sh         # Quick installer (delegates to nightowl.sh install)
├── schedule.json      # Runtime state (gitignored) — active schedule + lock state
├── .lock-password     # Lock password file (gitignored)
├── public/
│   ├── index.html     # Web UI
│   ├── app.js         # Frontend JavaScript
│   └── style.css      # Dark theme styles
├── com.nightowl.daemon.plist  # Template LaunchDaemon plist
├── DESIGN.md          # Architecture & anti-bypass design doc
└── package.json       # Node deps (express only)
```

## How It Works

1. **Web UI** (`server.js`) — User sets per-day curfew times (e.g., 10PM-6AM) and a lock duration (e.g., 7 days). Clicking "Lock It In" activates the schedule and makes it immutable for the lock period.

2. **Daemon** (`nightowld.sh`) — Runs as root via launchd. Every 60s checks if current time is within curfew. If yes: kills all user processes and shuts down the machine. Uses Python3 for timezone-aware time calculations.

3. **CLI** (`nightowl.sh`) — Install/uninstall the daemon, check status, run test mode.

4. **Focus Mode** — Quick lock for X minutes. Cannot be cancelled.

## Key Files to Understand

- `schedule.json` — The runtime state. Contains `active`, `lockEndDate`, `days` (per-day curfew times), `timezone`. Created at runtime, gitignored.
- `.lock-password` — Plain text password file. Used only for uninstall verification.
- `server.js` — The Express API. Routes: `GET/POST /api/schedule`, `POST /api/activate`, `GET /api/status`, `POST /api/focus`, `GET /api/focus`.

## Current State & Known Issues

### What Works
- Web UI renders and allows schedule configuration
- Schedule can be saved and activated via API
- Daemon script logic for curfew detection and enforcement
- Focus mode (timer-based quick lock)
- CLI install/uninstall/status commands

### What Needs Work

#### Critical — Must Fix
1. **Daemon has never been tested on actual macOS** — It was written on a Linux server. Needs real testing with `launchd`, `shutdown`, `killall`, etc.
2. **No graceful warning before shutdown** — DESIGN.md specifies 2-min and 30-sec warnings with macOS notifications, but `nightowld.sh` just immediately kills processes and shuts down. Need to add `osascript` notification alerts before enforcement.
3. **Password system is plaintext** — `.lock-password` stores raw password. Should use bcrypt hash (DESIGN.md specifies this).
4. **NTP time verification not implemented** — Daemon uses system time. DESIGN.md specifies NTP verification to prevent clock manipulation bypass.
5. **Self-healing not implemented** — Daemon should recreate its own plist/binary if deleted. Not coded yet.

#### Important — Should Fix
6. **Web server runs as user, not root** — The `com.nightowl.web.plist` created by install.sh doesn't specify a user, so it runs as root. Should run as the regular user.
7. **No authentication on web API** — Anyone on localhost can change the schedule. Should require password for modifications when locked.
8. **`schedule.json` is writable by user** — Even during a lock period, the user could just edit the JSON file directly. Should be owned by root with restricted permissions during active lock.
9. **No streak/history tracking** — The locked UI shows "survived N nights" but this is just calculated from lock start date, not actual compliance tracking.
10. **Focus mode doesn't actually enforce anything** — It's just a timer in the UI. No process killing or screen locking.

#### Nice to Have
11. **No sound/audio warnings** — Could play a sound before shutdown
12. **No "emergency unlock" with cooldown** — Sometimes you legitimately need the computer (on-call, emergencies)
13. **Mobile companion** — Status check from phone
14. **Config hash verification** — DESIGN.md mentions it but not implemented

## Development Commands

```bash
# Install dependencies
npm install

# Run web server locally (development)
node server.js

# Test daemon in test mode (no actual shutdown)
NIGHTOWL_TEST_MODE=1 NIGHTOWL_SCHEDULE=./schedule.json bash nightowld.sh

# Install as system service (requires sudo)
sudo bash install.sh

# Check status
bash nightowl.sh status

# Run daemon test (30s timeout)
bash nightowl.sh test
```

## Testing Strategy

### Unit/Integration Tests (Need to Create)
- Schedule parsing and curfew detection logic
- Time zone handling (overnight curfews crossing midnight)
- Lock period activation/expiration
- API endpoint behavior (locked vs unlocked states)
- Focus mode timer logic

### Manual Testing Checklist
- [ ] `npm install` succeeds
- [ ] `node server.js` starts on port 8899
- [ ] Web UI loads at http://localhost:8899
- [ ] Can set per-day schedule via UI
- [ ] Can select lock duration
- [ ] Presets (Night Owl, Early Bird, Weekend Flex) populate correctly
- [ ] "Copy Monday to all" works
- [ ] "Lock It In" activates schedule
- [ ] Locked UI shows correct progress, countdown, timeline
- [ ] Schedule cannot be modified while locked
- [ ] Lock expires after set duration
- [ ] Focus mode starts and shows countdown
- [ ] Focus mode cannot be cancelled
- [ ] `bash nightowl.sh status` shows correct info
- [ ] `NIGHTOWL_TEST_MODE=1 bash nightowld.sh` runs without errors
- [ ] Daemon correctly detects curfew vs free time
- [ ] `sudo bash install.sh` installs LaunchDaemons
- [ ] Daemon auto-starts after install
- [ ] Daemon survives being killed (launchd restarts it)
- [ ] Warning notifications appear before shutdown (once implemented)
- [ ] Actual shutdown occurs during curfew (careful with this one!)

### Edge Cases to Test
- Curfew crossing midnight (e.g., 22:00-06:00)
- Same-day curfew (e.g., 13:00-17:00)
- Lock period expiring mid-curfew
- Multiple rapid activations
- Server restart during active lock
- Timezone changes

## Code Style
- Vanilla JS (no TypeScript, no frameworks)
- Express for API
- Bash for daemon/CLI (uses Python3 for time calculations)
- Dark theme UI, Inter font
- Keep it simple — this is a single-user tool

## Important Constraints
- **macOS only** — uses launchd, osascript, macOS shutdown commands
- **Requires root for daemon** — enforcement must run as root to prevent user bypass
- **Node.js required** — for web server
- **Python3 required** — used by daemon for timezone-aware time calculations
- **No external services** — everything runs locally
- **The whole point is to be hard to bypass** — don't add easy escape hatches

## Default Schedule
```json
{
  "curfewStart": "22:00",
  "curfewEnd": "06:00",
  "timezone": "Asia/Kathmandu"
}
```
