# NightOwl 🦉 — Open Source Device Curfew System

**Force yourself off your computer. No compromises.**

## How It Works

A root-level daemon that enforces a shutdown schedule. If your computer is on during curfew hours, it shuts down. If you turn it back on, it shuts down again. That's it.

## Architecture

```
┌─────────────────────────────────────┐
│         nightowld (LaunchDaemon)     │
│         Runs as root, always alive   │
├─────────────────────────────────────┤
│  1. Boot → Check time (NTP/server)  │
│  2. In curfew? → Shutdown in 30s    │
│  3. Not in curfew? → Sleep until    │
│     curfew starts, then shutdown    │
│  4. Self-heal: recreate own files   │
│     if tampered with                │
└─────────────────────────────────────┘
```

## Anti-Bypass

| Attack | Defense |
|--------|---------|
| Kill process | launchd KeepAlive → auto-restart |
| Delete plist | Daemon watches + recreates it |
| Change system time | Uses NTP server time, not local clock |
| Edit config | Config owned by root, hardcoded hash check |
| Uninstall | Can't delete files owned by root while daemon runs |
| Recovery Mode | Can't prevent — but requires reboot + deliberate effort |

## Config

```json
{
  "version": 1,
  "schedule": {
    "start": "22:00",
    "end": "06:00",
    "timezone": "Asia/Kathmandu",
    "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
  },
  "grace_period_seconds": 60,
  "warning_seconds": 120,
  "lock": {
    "type": "password",
    "hash": "<bcrypt hash of unlock password>"
  },
  "time_source": "ntp",
  "ntp_server": "pool.ntp.org"
}
```

## Components

### 1. `nightowld` — The Daemon (Swift or Shell)
- Runs as root LaunchDaemon
- On start: fetch NTP time, check if in curfew
- If in curfew: display warning notification, shutdown after grace period
- If not: calculate seconds until curfew, sleep, then enforce
- Every 60s: verify own plist + binary exist, recreate if missing
- Logs to /var/log/nightowl.log

### 2. `nightowl` — CLI Tool
- `nightowl status` — show current schedule, active/inactive
- `nightowl install` — install daemon (requires sudo)
- `nightowl uninstall --password <pw>` — remove daemon (needs password)
- `nightowl config` — show config
- `nightowl set-schedule --start 22:00 --end 06:00 --password <pw>`
- `nightowl lock --password <pw>` — lock config changes
- `nightowl test` — simulate curfew for 2 minutes

### 3. `com.nightowl.daemon.plist` — LaunchDaemon
- RunAtLoad: true
- KeepAlive: true
- Owned by root:wheel

## File Layout

```
/usr/local/bin/nightowl          # CLI
/usr/local/bin/nightowld         # Daemon binary
/Library/LaunchDaemons/com.nightowl.daemon.plist
/etc/nightowl/config.json        # Config (root-owned)
/var/log/nightowl.log            # Logs
```

## Install Flow

```bash
curl -fsSL https://github.com/xxx/nightowl/install.sh | sudo bash
nightowl set-schedule --start 22:00 --end 06:00 --tz "Asia/Kathmandu"
nightowl lock --password "$(read -rsp 'Lock password: ' pw && echo $pw)"
```

## Warning Flow

1. **T-2 min**: macOS notification — "NightOwl: Computer will shut down in 2 minutes. Save your work!"
2. **T-30 sec**: Final warning — "Shutting down in 30 seconds..."
3. **T-0**: `shutdown -h now`

## Why Not Just...

- **Screen lock?** Touch ID bypasses it.
- **Password change?** Unreliable on Apple Silicon.
- **App blocker only?** You can still browse, code, waste time.
- **Willpower?** Lol.

## License

MIT
