# NightOwl — macOS Test Runbook

End-to-end verification on macOS for both v2 (running) and v3 (TypeScript monorepo, just made testable). Designed so you can confirm everything works without ever halting your machine — the daemon runs in dry-run mode so warnings + notifications fire but no actual shutdown.

## What gets tested

| Layer | What runs | What we verify |
|---|---|---|
| v3 shared logic | Jest unit tests | 55 tests across schedule + storage |
| v2 API + curfew detection | Jest + supertest | 33 tests covering API, overnight curfews, lock periods |
| v3 daemon decision flow | `node dist/index.js` with `NIGHTOWL_TEST_MODE=1` | Reads schedule.json from `NIGHTOWL_DATA_PATH`, computes timezone, decides curfew vs idle, logs the would-be enforcement steps |
| v3 daemon end-to-end | `sudo bash scripts/install-dev.sh` (dry-run) | Daemon under launchd, fires real macOS notifications at curfew, skips kill+halt |
| v3 desktop (Electron) | `npm run dev:desktop` | Renderer + IPC + daemon-status check |

## What we cannot test in software

The actual `halt -q` / `shutdown -h now` step. Verifying that requires letting the daemon take down your machine. The dry-run path runs every step up to and including the warning notifications, then logs "would shutdown" instead of actually shutting down.

## 1. One-time setup

```bash
cd /Users/asmeedhungana/indie/nightowl
npm install
npm run build:shared && npm run build:daemon && npm run build:desktop
```

Expected: three TypeScript builds succeed with no errors.

## 2. Run the full test suite

```bash
# v3 unit tests (shared package: schedule + storage)
npm run test:shared

# v2 supertest suite (API + curfew + lock period)
npx jest nightowl.test.js --testPathIgnorePatterns=packages
```

Expected: `Tests: 55 passed` for v3, `Tests: 33 passed` for v2.

## 3. Smoke-test the v3 daemon (no install, no sudo)

```bash
mkdir -p /tmp/nightowl-smoke
cat > /tmp/nightowl-smoke/schedule.json <<'EOF'
{
  "active": true, "lockPeriodDays": 1,
  "lockStartDate": "2026-05-05T00:00:00.000Z",
  "lockEndDate": "2026-05-06T00:00:00.000Z",
  "days": {
    "monday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "tuesday":   { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "wednesday": { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "thursday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "friday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "saturday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "sunday":    { "curfewStart": "00:00", "curfewEnd": "23:59" }
  },
  "timezone": "Asia/Kathmandu", "user": "asmeedhungana"
}
EOF

NIGHTOWL_TEST_MODE=1 \
NIGHTOWL_DATA_PATH=/tmp/nightowl-smoke \
NIGHTOWL_USER=asmeedhungana \
node packages/daemon/dist/index.js
```

Expected log within ~5 seconds:

```
NightOwl daemon v2.0.0 starting (PID: …)
*** TEST MODE ACTIVE ***
[…] CURFEW ACTIVE (00:00-23:59) - enforcing
=== CURFEW ENFORCEMENT (normal, TEST) ===
[TEST MODE] Would send 45-second warning
…
```

Press Ctrl-C to stop. This proves: (a) `NIGHTOWL_DATA_PATH` is honored, (b) curfew detection works, (c) decision flow reaches the enforcement step, (d) clean SIGINT shutdown.

## 4. Real-daemon dry-run (notifications fire, no halt)

This installs the daemon under launchd with `NIGHTOWL_DRY_RUN=1`. Curfew triggers fire **real macOS notifications** but `halt -q` is skipped. Safe.

```bash
# Default is dry-run mode
sudo bash scripts/install-dev.sh
```

Expected output ends with:

```
✓ plist:       /Library/LaunchDaemons/com.nightowl.daemon.plist
✓ Daemon loaded.
============== NEXT STEPS ==============
1. Watch the log:    tail -f /var/log/nightowl.log
2. Check it's alive: launchctl list | grep com.nightowl
…
Mode: DRY-RUN (warnings + notifications, no halt)
```

In a separate terminal:

```bash
tail -f /var/log/nightowl.log
```

You should see polling every 60 seconds. To trigger a curfew, drop an active schedule:

```bash
mkdir -p ~/Library/Application\ Support/NightOwl/
# Replace the curfew window with one that includes "right now":
# e.g. if it's 14:30, set curfewStart 14:25 curfewEnd 23:59
cat > ~/Library/Application\ Support/NightOwl/schedule.json <<EOF
{
  "active": true, "lockPeriodDays": 1,
  "lockStartDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "lockEndDate": "$(date -u -v+1d +"%Y-%m-%dT%H:%M:%SZ")",
  "days": {
    "monday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "tuesday":   { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "wednesday": { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "thursday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "friday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "saturday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "sunday":    { "curfewStart": "00:00", "curfewEnd": "23:59" }
  },
  "timezone": "$(systemsetup -gettimezone | awk '{print $NF}')",
  "user": "$(whoami)"
}
EOF
```

Within 60 seconds, the log should show `CURFEW ACTIVE … - enforcing`, then 45 seconds later a macOS notification should appear ("Computer will shut down in 45 seconds"), then 15s later the final-warning notification, then a "DRY-RUN" notification confirming shutdown was skipped.

To uninstall:

```bash
sudo bash scripts/install-dev.sh --uninstall
```

## 5. Electron desktop verification

```bash
npm run dev:desktop
```

Expected: an Electron window opens with the schedule UI. Click "Install Daemon" to test the sudo-prompt install flow (will replace the dry-run install from step 4 with one driven by the desktop app — also dry-run unless you set `NIGHTOWL_DRY_RUN=0` in the env when launching).

Verify in the renderer console (DevTools opens automatically):
- `daemon:status` IPC returns `{ installed: true, running: true }`
- Saving a schedule writes to `~/Library/Application Support/NightOwl/schedule.json` and includes a `user` field
- Activating the schedule prompts for a password, hashes it via bcrypt to `~/Library/Application Support/NightOwl/.lock-password`

## 6. v2 server (still works)

```bash
node server.js
```

Then in a browser: `http://127.0.0.1:8899` (NOT `0.0.0.0:8899` from another machine — bind is now localhost-only).

Expected: schedule UI loads. Lock-it-in flow round-trips. The v2 daemon (`bash nightowld.sh`) is unchanged and still works as documented in CLAUDE.md.

## 7. Switching from dry-run to real enforcement

When you actually want NightOwl to halt your machine at curfew:

```bash
sudo bash scripts/install-dev.sh --uninstall
sudo bash scripts/install-dev.sh --enforce  # will prompt for confirmation
```

After this, the daemon WILL run `halt -q` when curfew fires. There is no inline override — `sudo launchctl unload /Library/LaunchDaemons/com.nightowl.daemon.plist` is your panic button.

## Known limitations / what wasn't fixed

- **NTP / clock-tampering** — daemon trusts system time. Setting your clock outside the curfew window bypasses enforcement. (CLAUDE.md item #4, untouched.)
- **Self-healing** — if you `launchctl unload` the plist or `rm` the daemon dist, nothing restores it. (CLAUDE.md item #5, untouched.)
- **Code signing / notarization** — Electron app is not signed. Distribution to other users would hit Gatekeeper warnings.
- **Daemon binary bundling** — daemon ships as a Node script + node_modules, not a single executable. Production distribution would want esbuild or `@yao-pkg/pkg` for a single-binary install.
- **Windows** — code paths exist but untested in this pass; macOS only.
