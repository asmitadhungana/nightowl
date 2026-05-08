# CLAUDE.md — NightOwl 🦉

## Project Overview

NightOwl is a macOS device curfew system that enforces a shutdown schedule. A privileged daemon (LaunchDaemon, runs as root) shuts down the computer during curfew hours. A desktop UI lets the user configure schedules and arm enforcement. The whole point is to be hard to bypass.

**Target OS:** macOS (Apple Silicon primary; Intel via universal builds)
**Form factor (v1.0.0+):** Electron desktop app + LaunchDaemon (monorepo under `packages/`). The legacy `server.js` / `nightowld.sh` / `nightowl.sh` at the repo root are the pre-public iterations — kept for reference, not shipped.
**User:** This is a personal project for a single user (`asmeedhungana` macOS username)

## Release History

Public versioning starts at **v1.0.0**. Earlier dev iterations (internal v1/v2/v3 in commit history) were non-working and are superseded — do not treat them as releases. Add a new section here every time we ship a tagged release; keep each entry tight (≤ ~6 bullets per sub-section) so this file stays loadable.

### v1.0.0 — first prod release (2026-05-08)

Tag: `v1.0.0` · Release: https://github.com/asmitadhungana/nightowl/releases/tag/v1.0.0
Validated by a real **7-day enforced lock on macOS hardware** — curfew fired at 22:00, machine stayed locked until 06:00. This is the canonical "known-working" baseline; future versions revert here on regression.

**Core changes:**
- Daemon-status detection now uses `launchctl print system/<label>` (the user-context `launchctl list` does not surface system-domain daemons), with a `pgrep` fallback.
- Daemon working dir resolved by walking up to `node_modules`, so the packaged `.app/Contents/Resources/daemon/` and the dev tree both work.
- Lock + Focus buttons gated on daemon-running status, with explicit copy when the daemon is absent — no more silently armed enforcement.
- Pinned `electron` 28.3.3 for reproducible builds.
- App icons (icns/ico/png + tray templates), `scripts/build-mac.sh`, `scripts/generate-icon.py`.
- `/build/` (electron-builder output, ~440 MB) added to `.gitignore`.

**Core problems faced during development:**
- Daemon had never been exercised on real macOS hardware before this cycle (it was originally written on a Linux server). Until the 7-day test, end-to-end enforcement was theoretical.
- `launchctl list` from the user-context Electron process returned nothing for system-domain daemons → app reported "not running" while the daemon was actually running. Surfaced only on real hardware. Fixed via `launchctl print system/<label>`.
- Packaging path mismatch: dev expected `packages/daemon/` next to `dist/`, but the packaged `.app` puts the daemon under `Contents/Resources/daemon/`. Original install code computed working dir by `path.dirname(dirname(...))`, which broke in prod. Replaced with an upward walk for `node_modules`.
- Direct push to `main` and self-merge are blocked by permission rules on this repo — releases must go through a PR. Recorded so future ship cycles use a release branch + PR by default.
- GPG signing for the `v1.0.0` tag failed due to a broken pinentry on the dev machine. Shipped the tag unsigned; pinentry-mac was installed and `~/.gnupg/gpg-agent.conf` updated post-release so future tags can be signed.

**Known limitations carried forward into v1.x maintenance** (see "What Needs Work" below): graceful pre-shutdown warnings, bcrypt password hashing, NTP time-tampering check, daemon self-healing, schedule.json hardening, Focus-mode real enforcement.

### Template for future entries

```
### vX.Y.Z — short title (YYYY-MM-DD)

Tag: `vX.Y.Z` · Release: <link>
One-line "what this release is about" + how it was validated.

**Core changes:** (≤6 bullets, what shipped)
**Core problems faced:** (≤6 bullets, surprises / dead ends / fixed-mid-cycle issues — the stuff worth remembering)
**Known limitations carried forward:** (one line or list)
```

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
1. ~~**Daemon has never been tested on actual macOS**~~ — **RESOLVED in v1.0.0** (validated by 7-day lock test on real hardware).
2. **No graceful warning before shutdown** — DESIGN.md specifies 2-min and 30-sec warnings with macOS notifications, but the daemon just immediately kills processes and shuts down. Need to add `osascript` notification alerts before enforcement.
3. **Password system is plaintext** — `.lock-password` stores raw password. Should use bcrypt hash (DESIGN.md specifies this; `bcrypt` is already in `package.json` deps).
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
