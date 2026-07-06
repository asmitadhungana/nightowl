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

## 8. v2 Friend Lock — first-time bot bring-up (alpha)

**Status as of v2.0.0:** the Cloudflare Worker is deployed at `https://nightowl-bot.asmee-dh-work.workers.dev` and all three secrets are set (`TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `BOT_ED25519_PRIVKEY` — confirm with `npx wrangler secret list` from `packages/bot/`). The instructions below stay here for self-hosters and for re-deploys; if you're just running the app, **skip to §8.1 Pre-flight checks** and then §8.3 to drive a session with your friend.

### 8.1 Pre-flight checks (run before every friend-coordination session)

```bash
# 1. Worker is alive
curl -sS https://nightowl-bot.asmee-dh-work.workers.dev/healthz
# expect: ok

# 2. Telegram webhook is pointed at the Worker. Substitute your bot token from
#    @BotFather (NEVER paste this in shell history — store in a file, then delete):
TG_TOKEN=$(cat ~/.nightowl-bot-token)   # or wherever you keep it
curl -sS "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | python3 -m json.tool
# expect: "url" field matches the Worker /tg/webhook/<secret> path,
#         "pending_update_count" near 0, "last_error_date" absent or stale

# 3. (Optional) Tail live Worker logs while you test:
#    from a second terminal in packages/bot/
npx wrangler tail
# Anything that hits the Worker — /healthz, /tg/webhook, /desktop/* — shows up here.
```

If any of the three fail, fix before running the friend session — silent failures during pairing are the most confusing UX surface in v2.

### 8.2 Self-hoster setup (first-time bot deploy)

If you're standing up your own Worker rather than using the hosted one above, you need to:

```bash
cd packages/bot

# 1. Confirm what's set today (you should see exactly TG_WEBHOOK_SECRET + BOT_ED25519_PRIVKEY)
npx wrangler secret list

# 2. Get a bot token from @BotFather on Telegram (one-time)
#    Send @BotFather: /newbot  → pick a name → pick a username → save the token

# 3. Set it as a Worker secret.
#
#    IMPORTANT: `wrangler secret put` reads the value from STDIN, NOT from argv.
#    Putting the token on the same command line will fail with
#       ✘ [ERROR] Unknown argument: <token>
#    and (worse) wrangler logs the full argv on error to
#    ~/Library/Preferences/.wrangler/logs/wrangler-*.log — meaning your token
#    just landed in a file. If you do this by accident: revoke the token via
#    @BotFather (/revoke), delete the offending log file, and clear shell history.
#
#    Correct forms:
npx wrangler secret put TG_BOT_TOKEN
# wrangler prints "? Enter a secret value:" — paste the token there, hit Enter.

# Or, pipe from a file you delete right after (avoids shell history capture):
echo -n "<your-bot-token>" > /tmp/tgtok && \
  npx wrangler secret put TG_BOT_TOKEN < /tmp/tgtok && \
  rm /tmp/tgtok

# 4. Confirm the deployed URL
npx wrangler deployments status
# look for the workers.dev URL in the output (or check the Cloudflare dashboard)

# 5. Point Telegram at it (replace <TOKEN>, <WORKER_URL>, <SECRET>).
#    Use the SAME TG_WEBHOOK_SECRET value you set earlier — wrangler doesn't
#    surface it back. If you've forgotten it, rotate: `wrangler secret put
#    TG_WEBHOOK_SECRET < /tmp/sec` with a fresh `openssl rand -hex 32`, then
#    re-run the setWebhook below with the new value.
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER_URL>/tg/webhook/<SECRET>"
# expect: {"ok":true,"result":true,"description":"Webhook was set"}

# 6. Smoke-test from the Telegram client: DM the bot /help. You should get HELP_MESSAGE back.
#    If nothing comes back, `npx wrangler tail` from packages/bot/ to see live
#    request logs from the Worker.
```

Once the bot replies to `/help`, the desktop side can be brought up:

```bash
NIGHTOWL_BOT_URL=https://<WORKER_URL> npm run dev:desktop
```

If you're using the **hosted Worker** (the default since v2.0.0), `NIGHTOWL_BOT_URL` is unnecessary — `shared/src/identity.ts` bakes the URL in. Set it only when pointing at a local `wrangler dev` or a self-hosted Worker.

### 8.3 Friend-coordination session (driving an actual pair → setpassword → uninstall flow)

In the renderer: switch the lock-mode toggle to **Friend**, click **Generate Pair Code**, hand the 8-char code to a friend (or yourself in a second Telegram account), have them DM the bot `/pair <CODE>` then `/setpassword <PW>`. Within ~10 seconds the desktop should transition `enrolled → paired → awaiting_password → active` and the lock activates.

**Diagnostic signals during the session:**

- The pairing modal now surfaces a `⚠ Last warning` chip whenever a bot message is dropped (bad signature, replay, malformed payload). If the pairing seems stuck in `awaiting_password`, look at the chip first — it tells you whether the desktop is hearing the bot at all.
- `npx wrangler tail` from `packages/bot/` shows live Worker logs including each `/desktop/poll` hit. Useful for cross-checking when the chip says something dropped.
- The Telegram client shows the friend's `/setpassword` got `✓ Password sent` — that confirms the bot accepted it. Anything past that point is a desktop-side issue.

**If the desktop logs `bot unreachable`:** check internet, then `curl /healthz` per §8.1. If the hosted Worker is the issue (rare — it's a Cloudflare Worker, so uptime is near 100%), the maintainer needs to redeploy.

### 8.4 Exercising the uninstall path safely

The uninstall flow (Ask friend → /approve → Uninstall now) actually **uninstalls the daemon and tears down the active lock.** For dry-run testing during friend coordination, set `NIGHTOWL_UNINSTALL_DRY_RUN=1` in the desktop's environment before launching:

```bash
NIGHTOWL_UNINSTALL_DRY_RUN=1 npm run dev:desktop
# or, in a packaged build:
NIGHTOWL_UNINSTALL_DRY_RUN=1 open /Applications/NightOwl.app
```

With this set, the **Uninstall now** button still walks the entire IPC + delegation-clearing path (so you can verify the friend-approval flow end-to-end), but `daemon:uninstall` short-circuits to `ok` instead of actually invoking launchd. The active schedule lock stays intact. Use this for the first dry-run with your friend; clear the env var when you want a real install/uninstall cycle.

`NIGHTOWL_UNINSTALL_DRY_RUN` is the sibling of `NIGHTOWL_DRY_RUN`, which gates the daemon's `halt` action — same idea, different layer.

---

## 9. v3 Windows Lock — first-time install on Windows (alpha)

Windows port lives behind the same desktop UI / Friend Lock flow as macOS. The only platform-specific piece is the daemon: macOS uses a launchd plist running as root, Windows uses a Scheduled Task running as the user (Session 0 forces the user-session split — see `CLAUDE.md` v3 section for the architectural rationale).

### 9.1 Cross-build the Windows artifacts on macOS

The `nightowld.exe` daemon binary is produced from macOS via esbuild + `@yao-pkg/pkg`:

```bash
# From the monorepo root
npm install
npm run package:win -w packages/daemon

# Verify the produced binary
file packages/daemon/dist/nightowld.exe
#  → PE32+ executable (console) x86-64, for MS Windows
```

The .exe is ~41 MB, self-contained (Node runtime + bundled daemon code; no external deps because `bcrypt` is lazy-loaded in `@nightowl/shared/crypto.ts` and the daemon never calls password functions).

For an end-to-end NSIS installer that friends can download and run:

```bash
npm run package:win:installer
# → produces dist/NightOwl-Setup-<version>.exe (unsigned)
```

Unsigned means Windows SmartScreen will flag it on first run. Friends will see "Windows protected your PC" — they click **More info** → **Run anyway**.

### 9.2 Friend-side install (the .exe path)

What friends actually need to do once they have `NightOwl-Setup-<version>.exe`:

1. Right-click → **Run as administrator** (UAC is required so the installer can create the Scheduled Task).
2. Click through the NSIS wizard. Default install path is `C:\Users\<name>\AppData\Local\Programs\NightOwl`.
3. Launch NightOwl from the Start Menu.
4. In the app, click **Install Daemon** when prompted. A second UAC dialog appears — the desktop is registering the Scheduled Task via `schtasks /Create /XML`.
5. Verify the daemon is running:

   ```powershell
   schtasks /Query /TN NightOwlDaemon /FO LIST
   # Status: Running
   Get-Content $env:PROGRAMDATA\NightOwl\nightowl.log -Tail 20
   ```

6. Configure the schedule + lock duration in the UI, pair with a friend's Telegram bot (same flow as §8.2 — the bot doesn't care about OS), and **Lock It In**.

### 9.3 Developer install (no NSIS, fast iteration)

For us — and for developer friends — testing with a cloned repo:

```powershell
# From any PowerShell (elevated or not), in the repo root.
# The script auto-elevates via UAC if needed.
.\scripts\install-dev.ps1            # dry-run mode (safe — warnings fire, no shutdown)
.\scripts\install-dev.ps1 -Enforce   # actually shuts down on curfew (asks for "yes" confirmation)
.\scripts\install-dev.ps1 -Uninstall # remove the task
```

If PowerShell's execution policy blocks the .ps1 file (`script.ps1 cannot be loaded because running scripts is disabled on this system`), use the explicit bypass form — execution policy is scoped to the child process, nothing is persisted:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
```

The script:
- Self-elevates if you're not already in an admin shell — triggers exactly one UAC prompt, then everything (build + register + start) runs in the elevated child.
- Builds the daemon if `packages\daemon\dist\nightowld.exe` is missing (runs `npm install` + `npm run package:win -w packages/daemon`).
- Generates a Task Scheduler XML pointing at the dev `.exe` (NOT `%PROGRAMDATA%\NightOwl\` — that's the production install location).
- Registers the task as `NightOwlDaemon` running as the current user, logon trigger + 1-minute repetition.
- Starts the task immediately so you can `Get-Content $env:PROGRAMDATA\NightOwl\nightowl.log -Wait` and watch decisions.

**Friend-of-developer setup (one-shot, no further explanation needed):**

```powershell
git clone https://github.com/asmeedhungana/nightowl.git
cd nightowl
git checkout feat/v2-friend-lock-alpha
powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
```

Three lines, one UAC prompt, ~2-minute build, dry-run-safe daemon registered.

### 9.4 Drop a test schedule

The daemon reads `%APPDATA%\NightOwl\schedule.json`. To force an immediate dry-run enforcement (without using the UI):

```powershell
$schedulePath = "$env:APPDATA\NightOwl\schedule.json"
New-Item -ItemType Directory -Force -Path (Split-Path $schedulePath) | Out-Null
@"
{
  "active": true,
  "lockPeriodDays": 1,
  "lockStartDate": "2026-05-12T00:00:00.000Z",
  "lockEndDate": "2026-05-13T00:00:00.000Z",
  "days": {
    "monday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "tuesday":   { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "wednesday": { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "thursday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "friday":    { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "saturday":  { "curfewStart": "00:00", "curfewEnd": "23:59" },
    "sunday":    { "curfewStart": "00:00", "curfewEnd": "23:59" }
  },
  "timezone": "America/New_York",
  "user": "$env:USERNAME"
}
"@ | Set-Content -Path $schedulePath -Encoding UTF8
```

Within ~60 s the daemon's log should show `CURFEW ACTIVE` followed by the 45-second toast notification firing (look for the Windows action center toast). In dry-run mode it logs `[DRY-RUN] Would shutdown` and stops there.

### 9.5 Friend Lock on Windows (same as macOS)

The Friend Lock pairing + uninstall-approval flow is OS-agnostic. After the daemon is registered (§9.2 or §9.3) and the bot is reachable (§8), do exactly what §8.2 says — generate the pair code in the desktop UI, friend DMs the bot `/pair` + `/setpassword`, lock activates. `/approve` of an uninstall request also works identically.

### 9.6 What's NOT in W1

- **Tamper-resistance on `schedule.json`.** The Scheduled Task runs as the user (not SYSTEM), so it has no privilege the user doesn't already have to ACL the file. macOS's `chown root:wheel` equivalent is genuinely hard on Windows without elevating each schedule edit through UAC. See `CLAUDE.md` v3 section "load-bearing invariants" for the W2 plan.
- **Code signing of the NSIS installer.** Builds today are unsigned → SmartScreen warning on first run. Acquiring a code-signing cert is a v3.5 ops task.
- **Live-on-metal validation.** The cross-build from macOS produces a valid PE32+ binary, but Defender false-positives on unsigned new-publisher binaries can vary VM vs metal. Friends running the .exe on real hardware are the canary.
- **`getConsoleUser` Windows sibling.** Not needed — Task Scheduler runs the daemon as the user, so `os.userInfo().username` returns the right value directly. The `getTargetUser()` chain in `packages/daemon/src/core/enforce.ts` falls through correctly without a Windows-specific console-user lookup.

### 9.7 Uninstalling

From the app: click **Uninstall NightOwl** in the Settings panel. The desktop tears down Scheduled Task → kills `nightowld.exe` → deletes the installed `.exe`. `%APPDATA%\NightOwl\` (schedule + focus + pairing state) is intentionally preserved so re-installing is non-destructive.

From the command line:

```powershell
schtasks /End /TN NightOwlDaemon
taskkill /F /IM nightowld.exe
schtasks /Delete /TN NightOwlDaemon /F
Remove-Item "$env:PROGRAMDATA\NightOwl\nightowld.exe" -Force
```
