# NightOwl 🦉

**Force yourself off your computer. No compromises.**

A macOS daemon that enforces a device curfew by shutting down your computer during scheduled hours. Set a schedule, lock it for N days, and NightOwl handles the rest — including killing your processes and shutting down the machine if you're still on it during curfew.

## Features

- 🕐 **Per-day curfew schedules** — Different times for weekdays vs weekends
- 🔒 **Lock periods** — Commit for 7, 14, or 30 days. Can't be changed once locked.
- ⚡ **Focus mode** — Quick lock for 5–120 minutes. No cancelling.
- 🎨 **Web UI** — Dark-themed config dashboard at `localhost:8899`
- 🛡️ **Anti-bypass** — Runs as root via launchd with KeepAlive
- 📊 **Progress tracking** — See your commitment progress and streak

## Quick Start

### macOS

```bash
# Clone
git clone https://github.com/asmeedhungana/nightowl.git
cd nightowl

# Install deps
npm install

# Try the web UI first
node server.js
# Visit http://localhost:8899

# Install as system daemon (enables enforcement)
sudo bash install.sh
```

### Windows (alpha — v3 Windows Lock)

**End-users / non-developer friends.** Download `NightOwl-Setup-<version>.exe` from a release link, double-click, click through Windows SmartScreen ("More info" → "Run anyway" — the installer is currently unsigned), then click **Install Daemon** in the app after launch. Done.

**Developer friends (with Node 18+ and git).** From any PowerShell (elevated or not — the script self-elevates):

```powershell
git clone https://github.com/asmeedhungana/nightowl.git
cd nightowl
git checkout feat/v2-friend-lock-alpha
powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
```

That single `install-dev.ps1` invocation:
1. Auto-elevates via UAC (one prompt).
2. Runs `npm install` + builds all packages + cross-compiles `nightowld.exe`.
3. Registers a Scheduled Task running as you (logon trigger + 1-min watchdog).
4. Starts the daemon in **dry-run mode** (toast warnings fire, no actual shutdown).

To make it actually shut down on curfew, re-run with `-Enforce`. To remove it, `-Uninstall`. Full details + Friend Lock pairing in [RUNBOOK §9](RUNBOOK.md#9-v3-windows-lock--first-time-install-on-windows-alpha).

Build the NSIS installer yourself (e.g. to share with non-developer friends):

```bash
npm run package:win:installer
# → dist/NightOwl-Setup-<version>.exe (~150 MB)
```

## How It Works

1. **Configure** — Set curfew times per day via the web UI
2. **Commit** — Lock the schedule for N days
3. **Enforce** — Daemon runs as root, checks time every 60s. During curfew: kills user processes → shuts down machine
4. **Repeat** — Machine boots up? Daemon checks time. Still curfew? Shut down again.

## Components

| Component | File | Role |
|-----------|------|------|
| Web Server | `server.js` | Config UI + REST API on port 8899 |
| Daemon | `nightowld.sh` | Root-level curfew enforcer |
| CLI | `nightowl.sh` | Install/uninstall/status |
| Web UI | `public/` | Dark-themed schedule dashboard |

## CLI

```bash
nightowl status      # Show current schedule and curfew status
nightowl install     # Install daemon (requires sudo)
nightowl uninstall   # Remove daemon (requires password)
nightowl test        # Run daemon in test mode (30s, no real shutdown)
nightowl ui          # Open web UI in browser
```

## Requirements

- macOS (tested on Apple Silicon)
- Node.js 18+
- Python 3 (for timezone calculations in daemon)

## License

MIT
