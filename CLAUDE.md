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
- **macOS only in v1** — v1 daemon uses launchd, osascript, macOS shutdown commands. **v3 adds Windows** via a Task Scheduler-launched `nightowld.exe` (cross-built from macOS via `@yao-pkg/pkg`). See the v3 section below.
- **Requires root for daemon on macOS** — enforcement must run as root to prevent user bypass. **Windows daemon runs as the user** (Task Scheduler, not Windows Service) — Session 0 forces this trade-off; see v3 section.
- **Node.js required** — for web server
- **Python3 required** — used by daemon for timezone-aware time calculations
- **No external services for v1** — everything runs locally. **Narrowly relaxed in v2** for Friend Lock (Telegram bot + Cloudflare Worker, see the v2 section below). Anything beyond friend-mediated password delivery should still default to local.
- **The whole point is to be hard to bypass** — don't add easy escape hatches

## Default Schedule
```json
{
  "curfewStart": "22:00",
  "curfewEnd": "06:00",
  "timezone": "Asia/Kathmandu"
}
```

---

## v2 — Friend Lock (alpha, branch `feat/v2-friend-lock-alpha`)

NightOwl v2's headline is **Friend Lock**: a friend sets the lock password via a Telegram bot, so the primary user literally doesn't have the key to their own machine. Asymmetric by design — primary user picks the schedule, lock duration, and friend; friend only holds the password and gates uninstall.

```
packages/
├── shared/      # @nightowl/shared — types + Ed25519 identity + delegation lifecycle predicates
├── bot/         # @nightowl/bot — Cloudflare Worker; Telegram webhook + /desktop/* endpoints
├── desktop/     # @nightowl/desktop — Electron main + renderer; main/friendlock.ts is the orchestrator
└── daemon/      # legacy v1 daemon (untouched in v2)
```

### Load-bearing invariants

If a future request would relax any of these, push back. These are the rules that make Friend Lock meaningfully hard to bypass.

- **Plaintext password** lives only in the friend's Telegram client and the Worker isolate (where it is bcrypted before any KV write or log). The desktop only ever sees the bcrypt hash.
- **Every bot↔desktop message is Ed25519-signed.** Bot pubkey (`BOT_PUBKEY_HEX`) is baked into the desktop build; a compromised Worker can drop messages but cannot forge them. Replay defense: per-pairing `lastConsumedSeq`.
- **Friend powers are scoped:** set initial password, /approve|/deny uninstall, /revoke. Friend canNOT extend lock duration, modify the schedule, change the password mid-lock, or be swapped for a more compliant friend mid-lock.
- **`/revoke` is forward-looking — past approvals stand.** Once the friend has /approve'd an uninstall request, /revoke does NOT retract that approval; the user can still uninstall on the prior decision. The bot's revoke text is "you won't be *asked* to approve uninstall" (future tense). Allowing retraction would let a friend under social pressure trap the user — defangs the asymmetry. The locked-screen UI surfaces both facts when this state arises.
- **Approvals are scoped per request kind — one /approve does NOT cross-bless other actions.** Friend approving an uninstall request does not also green-light an early focus release, and vice versa. Each `kind` on the bot side maps to a distinct signed message kind on the wire and a distinct verdict store on the desktop side (`delegation.lastUninstallDecision` vs `focus.lastReleaseDecision`). When adding a new approval kind, do the same — never share a verdict slot.
- **72h emergency uninstall cooldown is the safety net AND is non-cancellable** once started. Cancellable would defang it under social pressure (hostile-friend scenario).
- **`uninstallGate(schedule)` in `packages/shared/src/delegation.ts` is the single source of truth** for "may the user uninstall right now?" Both the desktop API gate and the renderer UI consume it. Don't duplicate the branching elsewhere.

### Per-milestone history → `changes/`

Each milestone has a file in `changes/M<NN>-*.md` covering file-by-file changes, deferred work, and any operational gotchas. M1–M5 are also one git commit each; M6 onward lives entirely in `changes/`.

- **M1–M4** — shared foundation, Worker bot, desktop orchestrator, renderer pairing wizard (commits `ee27cbf` → `aedef53`)
- **M5** — first Worker deploy (Cloudflare upload, no commit)
- **M6** — uninstall request flow + 72h cooldown + `/revoke` `/approve` `/deny` + delegated `daemon:uninstall` gating
- **M7** — Friend Focus integration: opt-in friend-gated Focus sessions; same friend, distinct approval scope; new bot endpoint `/desktop/request-focus-release` + signed `focus_release_decision` message kind

For first-time bot bring-up, see `RUNBOOK.md §8`.

### Paths intentionally NOT taken

Refused options with reasons. If a future request asks for one of these, surface the reason rather than silently agreeing.

- **M-of-N friends** — v3 candidate; adds a key-management story v2 doesn't need.
- **In-app peer-to-peer (no Telegram)** — v3 candidate; needs NAT traversal + companion app + push.
- **Friend can extend lock / modify schedule / re-set password mid-lock** — caps hostage risk if the friend turns hostile.
- **Letting the user re-pair while a lock is active** — would let the user race the friend by swapping in a more compliant friend.
- **Rolling delegation that auto-renews** — re-pair to renew; auto-renew blurs the "user proposes, friend ratifies" line.
- **Telegram username as friend identifier** — handles change; we use the immutable `chat_id`.
- **Forwarding the friend's password to the desktop in cleartext** — defeats Friend Lock entirely.
- **Cancellable emergency cooldown** — defangs the safety net under social pressure.
- **Auto-uninstall when the cooldown elapses** — cooldown enables uninstall; user still has to click. Surprise auto-uninstall would lose work.

### Open work

- Set `TG_BOT_TOKEN` Worker secret and run the first real-Telegram E2E (see `RUNBOOK.md §8`).
- Bot integration tests — `packages/bot` currently has only a placeholder test script.
- Bake a hosted Worker URL into `BOT_URL` once the self-hosting story is settled (M6 added a packaged-build startup warning as a soft alternative).
- Self-healing daemon (carried over from v1 — see "Critical #5" above; not blocking v2).

---

## v3 — Windows Lock (alpha, branch `feat/v2-friend-lock-alpha` through W3)

Windows port of NightOwl. v2 Friend Lock + Friend Focus are OS-agnostic by construction (Cloudflare Worker bot, Ed25519, the pairing dance) — the only platform-specific layer is the enforcement daemon. v3 ships that for Windows.

### Architecture

```
nightowld.exe  (PE32+ x86-64, ~41 MB, self-contained Node + bundled CJS)
   ↑ tsc → esbuild --bundle --format=cjs --external:bcrypt → @yao-pkg/pkg
   ↑ packages/daemon/src/{index,core,windows,macos}/*

Registered via Windows Task Scheduler as `NightOwlDaemon`:
   - LogonTrigger as the user (NOT SYSTEM)
   - 1-minute repetition + MultipleInstancesPolicy=IgnoreNew (watchdog)
   - RunLevel=LeastPrivilege, LogonType=InteractiveToken (user session)
```

The desktop's `installDaemon` IPC on Windows generates the Task XML, writes a temp `.bat` that does `mkdir + copy + schtasks /Create /XML /F + schtasks /Run`, and invokes that .bat via `sudo-prompt`. Single UAC prompt for the user.

### Load-bearing decisions

If a future request would relax any of these, push back.

- **Task Scheduler, NOT Windows Service.** Services run in Session 0 — toast notifications never reach the user's desktop. The 45/15-second warning UX collapses to a silent kill. Realistic threat model is post-login bypass, which is exactly what Task-Scheduler-as-user covers.
- **Daemon binary is cross-built from macOS via `@yao-pkg/pkg`.** Reproducible, single command. `pkg` (the original) is unmaintained; `node-windows` adds a shipped runtime dep that we'd then have to maintain.
- **bcrypt is lazy-loaded in `@nightowl/shared/crypto.ts`** so the daemon bundle has no native dependencies. Verified `grep -c bcrypt dist/nightowld.cjs` → 0. The shape of `hashPassword` / `verifyPassword` is unchanged for callers.
- **Dry-run mode passes through `--dry-run` CLI arg**, not env vars. Task Scheduler XML's `<Exec>` action has no clean env-var injection on a `<Command>`. The daemon entry parses argv into `process.env.NIGHTOWL_DRY_RUN` so the enforcement-loop reads a single source.
- **`lockScheduleFile()` is a no-op on win32.** With daemon-as-user, any ACL it could set the user can unset — meaningful tamper-resistance requires either SYSTEM (Session 0 again) or per-activation UAC elevation. Deferred to W2; do NOT add a half-functional icacls call.

### Per-milestone history → `changes/`

- **W1** (2026-05-12) — `nightowld.exe` cross-build pipeline, Task Scheduler registration via `privileged.ts`, `scripts/install-dev.ps1`, `scripts/build-win.sh` standalone NSIS builder, RUNBOOK §9 covering install + Friend-Lock-on-Windows parity. No tamper resistance, no live-on-metal validation, no signed installer.

### Paths intentionally NOT taken (in addition to v2's list)

- **Running the daemon as SYSTEM with a user-mode helper.** Closes the tamper-resistance gap but doubles the moving parts. Promote later only if W3 metal-testing exposes user-deletes-the-task as a real-world bypass.
- **`getConsoleUser` Windows sibling.** macOS needs it because launchd runs daemon as root and we need to find the actual GUI user. Windows Task Scheduler runs the daemon AS the user, so `os.userInfo().username` is already correct; an extra layer would be dead code.
- **Code signing the NSIS installer.** ~$200/yr cost, SmartScreen reputation takes weeks to build. Friends acknowledge the unsigned warning during W3 testing.
- **Filesystem-level tamper-resistance on `schedule.json` in W1.** See the load-bearing decision above; W2 will revisit.
- **Universal x86-64 + ARM64 .exe.** ARM64 Windows install base is tiny; we ship x64 only.

### Open work

- **W2** — toast UX polish, decide on UAC-on-activation for `schedule.json` lockdown, validate dry-run path against real Defender behavior.
- **W3** — first live install on real Windows hardware. Bot pair + setpassword + uninstall request + Friend Focus E2E. RUNBOOK §9 already has the script.
- Self-healing daemon — still carried from v1, still not blocking.

---

## v4 — Android Lock (alpha, branch `feat/v4-android-alpha` through A4)

Android port of NightOwl. Same Cloudflare Worker bot, same Ed25519 wire format, same friend-held password — only the enforcement primitive differs. The macOS `shutdown` and Windows toast-then-lock pathways collapse to **repeated `DevicePolicyManager.lockNow()` + AccessibilityService-driven app blocking** because Android user apps can't power down the device.

### Architecture

```
packages/android/         ← standalone Gradle project, NOT in npm workspaces
├── app/build.gradle.kts  ← Compose 1.5.14, Tink 1.13.0, OkHttp 4.12, kotlinx.serialization
├── app/src/main/java/com/nightowl/
│   ├── MainActivity.kt + HomeViewModel.kt + ScheduleEditor.kt — Compose UI
│   ├── ScheduleStore.kt — DataStore-backed Schedule + DelegationState (mirrors shared/types)
│   ├── Identity.kt — Ed25519 keypair via Tink; BOT_PUBKEY_HEX matches packages/shared
│   ├── BotClient.kt — OkHttp client for /desktop/{enroll,poll,request-uninstall}
│   ├── PollLoop.kt — A2: recurring bot poll, sig verify, message dispatch
│   ├── CanonicalJson.kt — A2: byte-for-byte mirror of packages/bot/src/crypto.ts canonicalJson
│   ├── EnforcementService.kt — foreground service, 60s curfew tick + poll-loop coroutine
│   ├── AppBlockerService.kt — A2: AccessibilityService that bounces non-allowlisted apps during curfew
│   ├── NightOwlDeviceAdminReceiver.kt — DeviceAdmin for lockNow()
│   └── BootReceiver.kt — re-arms enforcement after reboot
```

### Load-bearing decisions

If a future request would relax any of these, push back.

- **Android stays out of the npm workspaces.** Root `package.json` does not list `packages/android` — verified at every Android milestone. Adds zero bytes to the macOS / Windows desktop bundle and removes the temptation to start cross-importing Kotlin↔TypeScript.
- **Wire format is shared with desktop, code is not.** `BOT_PUBKEY_HEX`, `botMessagePreimage`, and `canonicalJson` are duplicated in Kotlin (`Identity.kt`, `CanonicalJson.kt`) — same rules, separate implementations. Any change to the v2 wire format requires touching both sides.
- **Enforcement is `lockNow()` + AccessibilityService, not `shutdown`.** Android apps cannot power the device off. This is a meaningful threat-model degradation from macOS, documented in `packages/android/README.md` § Threat model.
- **No Device Owner provisioning in v4.** DeviceAdmin (revocable) + AccessibilityService (revocable) are the strongest primitives we use. Device Owner would close those gaps but requires factory-reset provisioning — outside the v4 scope.
- **Tight accessibility-service permission scope.** `canRetrieveWindowContent="false"` in `accessibility_service_config.xml`. We only need foreground package names. If future features need on-screen text, the prompted-permission copy + README threat model must widen.
- **Activate is gated on three preconditions:** device admin granted, friend delegation phase=`active` (password set), no unsaved schedule edits. Accessibility is recommended but not required — A1 screen-lock-only mode is a valid (weaker) fallback.

### Per-milestone history → `changes/`

- **A1** (`8215ba1`, 2026-05-13) — tracer-bullet scaffold. Compose UI for pairing + arming, Ed25519 identity, `DevicePolicyManager.lockNow()` during curfew, BootReceiver. Schedule editor + poll loop + app blocker all stubbed.
- **A2** (current, 2026-05-14) — schedule editor UI, bot poll loop (sig-verifies + dispatches all v2 message kinds), AccessibilityService app blocker. Tag: `android-v0.2.0-alpha.1`. See `changes/A02-schedule-editor-poll-loop-app-blocker.md`. **Real-device validation pending.**

### Paths intentionally NOT taken (in addition to v2's + v3's lists)

- **Device Owner mode.** Closes the user-can-disable-DeviceAdmin and user-can-disable-accessibility gaps but needs factory-reset provisioning. Reconsider only if A3+ metal testing shows the soft enforcement is ineffective in practice.
- **Reading window contents in the AccessibilityService.** Prompted-permission scope stays "package name only" — adding screen-text reading would change the social contract with users granting accessibility.
- **User-managed allowlist screen in A2.** Hardcoded allowlist is intentional for alpha — wider allowlist = weaker enforcement. A3 may add a curated UI screen.
- **Self-set lock (no friend) on Android.** Activate gates on phase=`active`. A "password-only, no Telegram" path is wired on macOS v1 but not yet in v4 — design decision for A3.
- **Sharing Kotlin code with desktop via KMP.** Out of scope; the two worlds are small enough that re-implementing canonical-JSON in 30 LOC beats setting up a Kotlin Multiplatform module.

### Open work

- **A3** — Uninstall request flow + 72h emergency cooldown UI + Friend Focus port + user-managed app-blocker allowlist screen.
- **A4** — F-Droid build reproducibility + signed release APK + `/install` bot command serves the APK to Android user-agents.
- **Real-device validation** — every A* milestone needs metal testing before we call it done. A2 has not yet been validated on physical hardware.
- Self-healing daemon — still carried from v1, still not blocking.

