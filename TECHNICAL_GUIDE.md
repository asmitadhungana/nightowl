# NightOwl Technical Guide

A deep dive into how NightOwl works under the hood. This guide explains the core concepts for anyone wanting to understand macOS daemons, process management, and system-level programming.

---

## Table of Contents

1. [What is a Daemon?](#1-what-is-a-daemon)
2. [launchd — macOS Process Manager](#2-launchd--macos-process-manager)
3. [How Processes Are Killed](#3-how-processes-are-killed)
4. [System Shutdown](#4-system-shutdown)
5. [Timezone-Aware Time Calculations](#5-timezone-aware-time-calculations)
6. [macOS Notifications](#6-macos-notifications)
7. [File Ownership for Security](#7-file-ownership-for-security)
8. [The Web Server (Express.js)](#8-the-web-server-expressjs)
9. [Architecture Flow Diagram](#9-architecture-flow-diagram)
10. [Key Takeaways](#10-key-takeaways)

---

## 1. What is a Daemon?

A **daemon** (pronounced "day-mon" or "dee-mon") is a background process that runs continuously without direct user interaction. The name comes from Greek mythology — a daemon is a spirit that works in the background.

### Key Characteristics

- Runs without a terminal/GUI attached
- Starts automatically at boot (or on-demand)
- Runs continuously in a loop
- Typically performs scheduled or event-driven tasks

### NightOwl's Daemon

In NightOwl, `nightowld.sh` is the daemon. Look at the main loop structure:

```bash
# nightowld.sh:298-333
while true; do
    # Check Focus Mode first
    if is_focus_active; then
        enforce_curfew "immediate"
        sleep 10
        continue
    fi

    # Check regular schedule
    if ! read_schedule; then
        sleep 60
        continue
    fi

    if is_curfew "$current_min"; then
        enforce_curfew
        sleep 30
    else
        sleep 60
    fi
done
```

It's an infinite `while true` loop that:
1. Checks the current state every 60 seconds
2. Reads the schedule from JSON
3. Decides whether to enforce curfew

---

## 2. launchd — macOS Process Manager

On macOS, **launchd** is the system that manages daemons. It's equivalent to:
- `systemd` on modern Linux
- `init.d` on older Unix systems
- Windows Services on Windows

### The plist File

launchd uses XML configuration files called **plist** (Property List) files. Here's what each part means:

```xml
<!-- com.nightowl.daemon.plist -->
<dict>
    <!-- Unique identifier for this daemon -->
    <key>Label</key>
    <string>com.nightowl.daemon</string>

    <!-- The command to run -->
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/nightowld</string>
    </array>

    <!-- Start immediately when loaded -->
    <key>RunAtLoad</key>
    <true/>

    <!-- THE KEY FEATURE: Restart if it dies -->
    <key>KeepAlive</key>
    <true/>

    <!-- Log output location -->
    <key>StandardOutPath</key>
    <string>/var/log/nightowl.log</string>
</dict>
```

### Key launchd Configuration Options

| Key | Meaning |
|-----|---------|
| `RunAtLoad` | Start the daemon when the plist is loaded (at boot) |
| `KeepAlive` | **Critical**: If the process dies, launchd automatically restarts it |
| `Label` | Unique identifier (reverse-DNS convention) |
| `WorkingDirectory` | The directory the process runs in |
| `EnvironmentVariables` | Environment variables to set for the process |
| `StandardOutPath` | Where to write stdout logs |
| `StandardErrorPath` | Where to write stderr logs |

The **`KeepAlive: true`** setting is what makes this hard to bypass — if you `kill` the daemon, launchd immediately respawns it.

### Where plist Files Live

```
/Library/LaunchDaemons/     <- System-wide daemons (runs as root)
/Library/LaunchAgents/      <- System-wide agents (runs as user)
~/Library/LaunchAgents/     <- Per-user agents (runs as that user)
```

NightOwl uses `/Library/LaunchDaemons/` so it runs as **root** — which is necessary to kill user processes and shut down the machine.

### launchctl Commands

```bash
# Load (start) a daemon
sudo launchctl load /Library/LaunchDaemons/com.nightowl.daemon.plist

# Unload (stop) a daemon
sudo launchctl unload /Library/LaunchDaemons/com.nightowl.daemon.plist

# Check if daemon is running
sudo launchctl list | grep nightowl

# See detailed info about a daemon
sudo launchctl print system/com.nightowl.daemon
```

### Daemon vs Agent

| Type | Location | Runs As | Use Case |
|------|----------|---------|----------|
| LaunchDaemon | `/Library/LaunchDaemons/` | root | System services, privileged operations |
| LaunchAgent | `~/Library/LaunchAgents/` | Current user | User-facing apps, menu bar items |

NightOwl uses a **LaunchDaemon** because it needs root privileges to:
- Kill processes owned by any user
- Shut down the computer
- Modify file ownership

---

## 3. How Processes Are Killed

The daemon uses several Unix commands to terminate processes:

```bash
# nightowld.sh:270-276
killall -u "$TARGET_USER" -9 2>/dev/null || true
sleep 1
killall -u "$TARGET_USER" -9 2>/dev/null || true
sleep 1
pkill -9 -u "$TARGET_USER" 2>/dev/null || true
```

### Understanding the Commands

| Command | Purpose |
|---------|---------|
| `killall -u asmeedhungana -9` | Kill ALL processes owned by user "asmeedhungana" |
| `pkill -9 -u asmeedhungana` | Same thing, different implementation |
| `-9` | Signal SIGKILL — immediate termination, no cleanup |
| `2>/dev/null` | Suppress error messages (redirect stderr to null) |
| `|| true` | Don't exit script if command fails |

### Unix Signals

Processes communicate via **signals**. Here are the most common ones:

| Signal | Number | Name | Effect |
|--------|--------|------|--------|
| SIGHUP | 1 | Hang Up | Terminal disconnected; often used to reload config |
| SIGINT | 2 | Interrupt | Ctrl+C pressed; polite termination request |
| SIGQUIT | 3 | Quit | Ctrl+\ pressed; terminate and dump core |
| SIGKILL | 9 | Kill | **Forced termination** (cannot be caught or ignored) |
| SIGTERM | 15 | Terminate | Polite request to terminate (default for `kill`) |
| SIGSTOP | 19 | Stop | Pause the process (cannot be caught) |
| SIGCONT | 18 | Continue | Resume a stopped process |

### Why `-9` (SIGKILL)?

`SIGKILL` is the "nuclear option" — the kernel immediately terminates the process:

- **Cannot be caught**: The process cannot install a signal handler for SIGKILL
- **Cannot be ignored**: The process cannot ignore this signal
- **No cleanup**: No destructors run, no files are flushed, no graceful shutdown
- **Immediate**: The kernel removes the process from the process table

This is necessary for enforcement because a clever user could write an app that catches SIGTERM and refuses to die.

### Why Root is Required

Only root (UID 0) can:
- Kill processes owned by other users
- Run `shutdown` or `halt`
- Write to `/var/log/`
- Change file ownership with `chown`
- Load daemons into `/Library/LaunchDaemons/`

---

## 4. System Shutdown

```bash
# nightowld.sh:279-281
halt -q 2>/dev/null || shutdown -h now 2>/dev/null || true
sleep 3
/sbin/halt -q 2>/dev/null || true
```

### Shutdown Commands

| Command | Effect |
|---------|--------|
| `halt -q` | Immediate halt (quiet mode, no wall message) |
| `shutdown -h now` | Scheduled shutdown (h=halt, now=immediately) |
| `/sbin/halt -q` | Full path version (in case PATH isn't set) |

### Why Multiple Commands?

Different macOS versions have slightly different implementations. The fallback chain ensures at least one works:

1. Try `halt -q`
2. If that fails, try `shutdown -h now`
3. Sleep 3 seconds (give shutdown time to work)
4. Try `/sbin/halt -q` as last resort

---

## 5. Timezone-Aware Time Calculations

The daemon uses Python for time calculations because Bash lacks good timezone support:

```bash
# nightowld.sh:156-163
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
```

### How It Works

1. Set the `TZ` environment variable to the configured timezone (e.g., "Asia/Kathmandu")
2. Call `time.tzset()` to apply the timezone
3. Get the current time in that timezone
4. Convert to "minutes since midnight" (0-1439) for easy comparison

### Overnight Curfew Logic

The tricky part is handling curfews that cross midnight (e.g., 22:00 to 06:00):

```bash
# nightowld.sh:185-190
if (( start_min > end_min )); then
    # Curfew crosses midnight (e.g., 22:00 to 06:00)
    (( current_min >= start_min || current_min < end_min )) && return 0
else
    # Same-day curfew (e.g., 13:00 to 17:00)
    (( current_min >= start_min && current_min < end_min )) && return 0
fi
```

### Example: 22:00-06:00 Curfew

Convert to minutes:
- 22:00 = 22 * 60 + 0 = **1320 minutes**
- 06:00 = 6 * 60 + 0 = **360 minutes**

Since 1320 > 360, this is an **overnight curfew**.

Test cases:
| Current Time | Minutes | In Curfew? | Reason |
|--------------|---------|------------|--------|
| 23:00 | 1380 | YES | 1380 >= 1320 |
| 03:00 | 180 | YES | 180 < 360 |
| 12:00 | 720 | NO | 720 < 1320 AND 720 >= 360 |
| 06:30 | 390 | NO | 390 >= 360 AND 390 < 1320 |

---

## 6. macOS Notifications

```bash
# nightowld.sh:196-202
notify() {
    local title="$1"
    local message="$2"
    sudo -u "$TARGET_USER" osascript -e \
        "display notification \"$message\" with title \"$title\" sound name \"Submarine\""
}
```

### Breaking It Down

| Part | Purpose |
|------|---------|
| `sudo -u "$TARGET_USER"` | Run as the user (not root) so notification appears on their screen |
| `osascript -e` | Execute AppleScript from command line |
| `display notification` | AppleScript command for macOS notifications |
| `with title` | Set the notification title |
| `sound name "Submarine"` | Play a built-in macOS sound |

### Why `sudo -u`?

The daemon runs as root, but notifications need to appear on the user's desktop. macOS notifications are per-user, so we use `sudo -u username` to run the osascript command as that user.

### Available Sounds

macOS has several built-in notification sounds:
- Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink

---

## 7. File Ownership for Security

```bash
# nightowld.sh:64-74
lock_schedule_file() {
    if [[ "$EUID" -eq 0 ]] && [[ -f "$SCHEDULE_FILE" ]]; then
        chown root:wheel "$SCHEDULE_FILE"
        chmod 644 "$SCHEDULE_FILE"
    fi
}
```

### Understanding Unix Permissions

File permissions in Unix have three components:

```
-rw-r--r--  1 root wheel  751 Feb 26 schedule.json
│├─┤├─┤├─┤    │    │
│ │  │  │     │    └── Group (wheel = admin group on macOS)
│ │  │  │     └─────── Owner (root)
│ │  │  └───────────── Other permissions (r-- = read only)
│ │  └──────────────── Group permissions (r-- = read only)
│ └─────────────────── Owner permissions (rw- = read/write)
└───────────────────── File type (- = regular file)
```

### Numeric Permissions

| Digit | Meaning |
|-------|---------|
| 4 | Read (r) |
| 2 | Write (w) |
| 1 | Execute (x) |

So `chmod 644` means:
- Owner: 6 = 4+2 = read+write
- Group: 4 = read only
- Other: 4 = read only

### How Lock/Unlock Works

**When schedule is locked:**
```bash
chown root:wheel "$SCHEDULE_FILE"  # root owns the file
chmod 644 "$SCHEDULE_FILE"          # owner can write, others can only read
```

The user can read the schedule but cannot modify it (they're "other", not "owner").

**When schedule is unlocked:**
```bash
chown "$user:staff" "$SCHEDULE_FILE"  # user owns the file
chmod 644 "$SCHEDULE_FILE"             # owner can write
```

Now the user can modify the file because they're the owner.

---

## 8. The Web Server (Express.js)

`server.js` is a Node.js Express server that provides the web UI and API:

```javascript
const express = require('express');
const app = express();

// Middleware
app.use(express.json());                    // Parse JSON request bodies
app.use(express.static('public'));          // Serve static files (HTML/CSS/JS)

// API Routes
app.get('/api/schedule', ...);              // Read current schedule
app.post('/api/schedule', ...);             // Update schedule (when unlocked)
app.post('/api/activate', ...);             // Lock the schedule
app.get('/api/status', ...);                // Get current status
app.post('/api/focus', ...);                // Start focus mode
app.get('/api/focus', ...);                 // Get focus mode status
```

### How Components Communicate

```
Browser (Web UI)     server.js (API)      nightowld.sh (Daemon)
      │                   │                      │
      │  HTTP POST        │                      │
      ├──────────────────►│                      │
      │  /api/schedule    │                      │
      │                   │                      │
      │                   │  write               │
      │                   ├─────────────────────►│
      │                   │  schedule.json       │
      │                   │                      │
      │                   │                      │ read (every 60s)
      │                   │◄─────────────────────┤
      │                   │                      │
      │  HTTP 200 OK      │                      │
      │◄──────────────────┤                      │
```

The web server and daemon communicate through the **shared `schedule.json` file**:
- Web server **writes** to schedule.json when user makes changes
- Daemon **reads** schedule.json every 60 seconds to check for curfew

---

## 9. Architecture Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           User                                      │
│                             │                                       │
│                             ▼                                       │
│                    ┌─────────────────┐                              │
│                    │   Web Browser   │                              │
│                    │ localhost:8899  │                              │
│                    └────────┬────────┘                              │
│                             │ HTTP API                              │
│                             ▼                                       │
│                    ┌─────────────────┐                              │
│                    │   server.js     │  ◄── Express web server      │
│                    │   (Node.js)     │      runs as LaunchDaemon    │
│                    └────────┬────────┘                              │
│                             │                                       │
│                             ▼                                       │
│                    ┌─────────────────┐                              │
│                    │  schedule.json  │  ◄── Shared state file       │
│                    └────────┬────────┘                              │
│                             │                                       │
│                             ▼                                       │
│                    ┌─────────────────┐                              │
│                    │  nightowld.sh   │  ◄── Daemon (runs as root)   │
│                    │  (Bash daemon)  │      Reads schedule every 60s│
│                    └────────┬────────┘                              │
│                             │                                       │
│            ┌────────────────┼────────────────┐                      │
│            ▼                ▼                ▼                      │
│    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              │
│    │ killall -9   │ │  osascript   │ │   shutdown   │              │
│    │ (kill apps)  │ │ (notify)     │ │  (halt Mac)  │              │
│    └──────────────┘ └──────────────┘ └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. Key Takeaways

1. **Daemons** are background processes that run in an infinite loop, checking state and performing actions

2. **launchd** is macOS's process manager that loads daemons via XML plist files

3. **`KeepAlive: true`** makes daemons self-healing — if killed, launchd automatically restarts them

4. **SIGKILL (-9)** is the only reliable way to forcefully terminate a process — it cannot be caught or ignored

5. **Root privileges** are required to kill other users' processes and shut down the system

6. The daemon and web server communicate via a **shared JSON file** — simple but effective

7. **File ownership** (`chown` to root) prevents users from editing config files during lockout

8. **Timezone handling** requires careful math, especially for curfews crossing midnight

9. **osascript** bridges the gap between shell scripts and macOS GUI features like notifications

10. **Multiple fallback commands** (like `halt || shutdown || /sbin/halt`) ensure compatibility across macOS versions

---

## Further Reading

- [launchd.plist man page](https://www.manpagez.com/man/5/launchd.plist/)
- [Unix Signals](https://man7.org/linux/man-pages/man7/signal.7.html)
- [Express.js Documentation](https://expressjs.com/)
- [Python datetime module](https://docs.python.org/3/library/datetime.html)
