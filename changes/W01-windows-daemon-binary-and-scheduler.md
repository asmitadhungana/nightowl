# W1 — Windows daemon binary + Task Scheduler registration

- **Date:** 2026-05-12
- **Branch:** `feat/v2-friend-lock-alpha` (Windows port lives on same branch through W3)
- **Commit:** uncommitted at session end
- **Tests:** 102/102 green (no new tests; existing shared suite passes after `bcrypt` lazy-load refactor)
- **Builds:** four-package monorepo tsc clean; `nightowld.exe` cross-builds from macOS (PE32+ x86-64, ~41 MB)

## What this milestone delivers

NightOwl can now register a working enforcement daemon on Windows. After W1:

- A single `nightowld.exe` binary cross-builds from macOS via esbuild + `@yao-pkg/pkg`.
- The desktop app's "Install Daemon" path on Windows registers a **Scheduled Task** (not a Windows Service) running as the user, so toast notifications and shutdowns reach the actual desktop session.
- The dry-run path matches macOS's: 45 s warning toast → 15 s warning toast → "would shutdown" log entry, no actual halt.
- A `scripts/install-dev.ps1` mirrors `install-dev.sh` for friends with the repo cloned.

Friend Lock pairing, Friend Focus, the bot, and the renderer are unchanged — they were already OS-agnostic.

## Architectural decisions settled before code

### Task Scheduler over Windows Service

Documented at length in the conversation that opened this milestone. Short version:

- A Windows Service runs in Session 0. Toast notifications fired there don't reach the user's desktop session. The 45/15-second warning UX collapses to a silent kill.
- A Scheduled Task with a `LogonTrigger` running as the user runs in the user session. Toasts attribute correctly and `shutdown /s /f /t 0` ends the right session.
- Trade-off: the user-session task is less tamper-resistant than a service. The user owns the task and can `schtasks /Delete` it. Pre-login enforcement is also gone. We accept this for W1 — the realistic threat model is "user wants to bypass at curfew," which is always post-login. A v3.5 hardening path would be service + user-helper IPC.

### `@yao-pkg/pkg` + esbuild over alternatives

- `pkg` (the original) is unmaintained.
- `node-windows` wraps a Node script as a service via a stub — adds a runtime dependency we have to ship, and is service-shaped which loses to the Task Scheduler decision above.
- `@yao-pkg/pkg` (maintained fork) cross-builds from macOS to `node20-win-x64` cleanly and produces a single 41 MB self-contained .exe.

Daemon source is ESM but `pkg` and friends only digest CJS reliably. The pipeline is:

```
tsc → dist/index.js (ESM, native imports)
  ↓
esbuild --bundle --platform=node --format=cjs --external:bcrypt
  ↓
dist/nightowld.cjs (single-file CJS, 24 KB)
  ↓
pkg --targets node20-win-x64
  ↓
dist/nightowld.exe (PE32+, 41 MB, Node baked in)
```

### Lazy-load `bcrypt` in shared

`@nightowl/shared/index.ts` re-exports `crypto.ts`, which top-level-imported `bcrypt`. The daemon imports `appendLog` / `loadSchedule` from shared, which pulls `crypto.ts` into the import graph, which would pull `bcrypt` (native module) into the .exe bundle. Native modules + cross-compile is fragile.

Fix: lazy-load `bcrypt` inside `hashPassword` / `verifyPassword`. Function signatures stay async-returning so callers are unchanged. Daemon never executes the inner code, so the runtime `import('bcrypt')` never fires inside the .exe.

Verified: `grep -c bcrypt dist/nightowld.cjs` → 0.

### Dry-run via `--dry-run` CLI flag, not env vars

Task Scheduler XML's `<Exec>` action has no clean way to set process environment variables. Options were:
- `cmd.exe /c "set X=Y && exe"` wrapper inside `<Command>` — ugly, fragile escaping.
- Wrapper `.cmd` file alongside the .exe — extra file to maintain.
- CLI flag `--dry-run` parsed by the daemon entry — cleanest.

Picked the CLI flag. The daemon's `main()` sets `process.env.NIGHTOWL_DRY_RUN` from `process.argv` so the rest of the enforcement loop reads from a single source. macOS plist continues to use env vars; both paths converge.

### Tamper-resistance on `schedule.json` is a no-op for W1

`lockScheduleFile()` and `unlockScheduleFile()` in `packages/shared/src/storage.ts` now early-return on `win32`. The reasoning: the Task Scheduler daemon runs as the user, so any ACL it could set, the user can unset. Real lockdown requires either:
- Running as SYSTEM (re-introduces Session 0 problem), or
- Elevating every schedule activation through UAC (UX friction).

Tracked as W2 follow-up; see `CLAUDE.md` v3 section.

## What changed (by file)

### Shared

- **`packages/shared/src/crypto.ts`** — replaced `import bcrypt from 'bcrypt'` with a lazy `getBcrypt()` helper. Both `hashPassword` and `verifyPassword` now `await getBcrypt()` inside the function body. Cached after first load.
- **`packages/shared/src/storage.ts`** — `lockScheduleFile()` and `unlockScheduleFile()` now early-return on `win32`. Long comment block explains the W2 follow-up rather than silently doing nothing.

### Daemon

- **`packages/daemon/src/index.ts`** — `main()` parses `--dry-run` and `--test-mode` from `process.argv` into the corresponding env vars before anything else reads them. Log line announces dry-run mode if set.
- **`packages/daemon/src/windows/service.ts`** — deleted. Dead code from the v3 scaffold; new Task Scheduler logic lives in `packages/desktop/src/main/privileged.ts` (mirroring how macOS plist generation lives in `privileged.ts` rather than a daemon-side helper).
- **`packages/daemon/src/windows/enforcer.ts`** — untouched. Toast notification + `taskkill` + `shutdown /s /f /t 0` were already implementable; they only didn't reach the user before because we were going to run them in Session 0. Now they run in the user session via Task Scheduler.
- **`packages/daemon/package.json`** — added `@yao-pkg/pkg` + `esbuild` to devDeps; replaced the broken `package` script (referenced the unmaintained `pkg` package) with `bundle:cjs` and `package:win`. Removed dead `node-windows` `optionalDependencies` entry.

### Desktop

- **`packages/desktop/src/main/privileged.ts`**:
  - New constants `WINDOWS_TASK_NAME`, `WINDOWS_INSTALL_DIR`, `WINDOWS_DAEMON_EXE`.
  - `getWindowsDaemonStatus()` now queries `schtasks /Query /TN NightOwlDaemon /FO LIST` and parses the Status field. `sc query` is gone.
  - `installWindowsDaemon()`:
    1. Resolves user identity in pre-elevation context (UAC would replace `%USERNAME%` with the admin account).
    2. Generates Task Scheduler XML (UTF-16 LE with BOM as required by `schtasks /XML`).
    3. Writes a temp install `.bat` that copies the .exe + registers + starts the task atomically under one UAC elevation.
    4. Runs the .bat via `sudo-prompt`. Single UAC prompt for the user.
  - `uninstallWindowsDaemon()` follows the same temp-bat pattern: `schtasks /End` → `taskkill` → `schtasks /Delete` → `del nightowld.exe`. All wrapped in `2>nul` so partial-install states still uninstall cleanly.
  - `getDaemonPath()` now picks the filename based on platform (`nightowld.exe` on Windows, `index.js` elsewhere). Three search paths unchanged.
  - New helpers: `createWindowsTaskXml(opts)` + `resolveWindowsUserIdentifier()`.

### Build pipeline

- **`scripts/build-win.sh`** — new. Mirrors `build-mac.sh` (standalone build dir, packed `@nightowl/shared` tarball, standalone `electron-builder.yml`) but does NOT vendor `bcrypt` or shared next to the daemon — the .exe is self-contained. Produces unsigned NSIS installer at `dist/NightOwl-Setup-<version>.exe`.
- **`scripts/install-dev.ps1`** — new. PowerShell sibling of `install-dev.sh`. Builds the .exe if missing, generates dev Task XML pointing at `packages\daemon\dist\nightowld.exe`, registers + starts. `-Enforce` flag flips off dry-run. `-Uninstall` flag tears down.
- **`package.json`** (root) — added `package:mac:installer` + `package:win:installer` scripts that wrap the bash builders, for discoverability via `npm run`.

### Docs

- **`RUNBOOK.md`** — appended §9 with seven subsections covering: cross-build on macOS, NSIS installer for friends, dev install via PowerShell, dropping a test schedule, Friend Lock parity on Windows, what's NOT in W1, and uninstall procedure.

## Deferred to W2 / W3

- **`schedule.json` ACL lockdown** (W2). Either UAC-elevated activations OR a SYSTEM helper service.
- **Friend Lock + Friend Focus live E2E on real Windows hardware** (W3). The cross-build is verifiably a PE32+ binary, but Defender false-positives and SmartScreen behavior need a friend running it on metal.
- **Code signing the NSIS installer** (v3.5 ops). Requires a code-signing cert (~$200/yr).
- **`getConsoleUser` Windows sibling**. Not needed — Task Scheduler daemon runs AS the user, so `os.userInfo().username` returns the correct user directly. The `getTargetUser()` chain in `packages/daemon/src/core/enforce.ts` already falls through correctly.

## Open question for the next session

Whether to add a UAC-prompted "lockdown schedule.json" flow on schedule activation (W2 scope). The friction cost is one UAC dialog per `Lock It In`, but it closes the casual-edit bypass. Discuss before implementing.
