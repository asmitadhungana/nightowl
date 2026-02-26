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
