# @nightowl/android — Android port (v4 alpha)

This package is the Android port of NightOwl. It pairs with the same Cloudflare
Worker bot that the macOS and Windows builds use; the bot is OS-agnostic by
design (see `CLAUDE.md` § v2). What's platform-specific is the **enforcement**
layer, and that's where Android diverges materially from desktop.

## What this is

- **Standalone Gradle project** under `packages/android/`. NOT part of the npm
  workspace — Kotlin/Gradle and TypeScript/npm are two different worlds and we
  don't try to bridge them. `package.json` workspaces verified to exclude
  `packages/android/`, so the macOS / Windows desktop bundle is unaffected by
  anything in this directory.
- **A3 milestone (current):** schedule editor + bot poll + accessibility blocker
  (from A2), plus uninstall request flow + 72h non-cancellable emergency cooldown +
  Friend Focus (solo + friend-gated) + user-managed allowlist. Real friend can
  `/approve` an uninstall request end-to-end, the cooldown safety net is
  exercisable, and focus sessions work.
- **A5 (current):** **first real-device validation** — a full pair → setpassword →
  7-day friend-lock → enforcement loop ran on a Xiaomi Mi 9 Lite (MIUI), plus the
  fixes that took to get there (instant-relock, self-healing watchdog, post-expiry
  stand-down). Tested-device log + OEM gotchas: **[`DEVICE-TESTING.md`](./DEVICE-TESTING.md)**.

## Architecture (Android-specific)

```
MainActivity (Compose UI)
   ↓ enroll / setSchedule
BotClient (OkHttp + Ed25519 via Tink)  ← talks to the SAME Worker the desktops use
   ↓
EnforcementService (foreground service, ticks every 60s)
   ↓ during curfew
DevicePolicyManager.lockNow()  ← Android equivalent of macOS shutdown
   ↓ via
NightOwlDeviceAdminReceiver  ← user must grant via Settings → Security
```

## What's wired vs. stubbed

| Concern | State |
|---|---|
| Ed25519 identity (gen, persist, sign) | wired — Tink, raw 32-byte keys, base64 sigs, same wire format as desktop |
| BOT_URL + bot pubkey hardcoded | wired — pubkey baked into `Identity.kt`, matches `packages/shared/src/identity.ts` |
| `POST /desktop/enroll` | wired — `BotClient.enroll()` returns pairingId + pairCode |
| `POST /desktop/poll` | wired — recurring caller in `PollLoop` running inside `EnforcementService` |
| `POST /desktop/request-uninstall` | **A3 — wired.** "Ask friend" button + pendingUninstallReqId tracking + decision-clearing in PollLoop |
| `POST /desktop/request-focus-release` | **A3 — wired.** Mirror of desktop M7; solo focus stays uncancellable |
| 72h emergency cooldown | **A3 — wired.** Non-cancellable; hard-confirm dialog; countdown UI; `uninstallGate` auto-flips when elapsed |
| User-managed allowlist | **A3 — wired.** Additive-only; safety-critical defaults (dialer, Settings, system UI) cannot be removed |
| Curfew schedule storage (DataStore) | wired — `ScheduleStore` reads/writes JSON; default empty |
| Curfew-time math (incl. overnight) | wired — `Schedule.isCurfewActive()` handles start≤end + start>end |
| Foreground service + 60s tick | wired — `EnforcementService` |
| `DevicePolicyManager.lockNow()` during curfew | wired |
| Boot persistence | wired — `BootReceiver` re-arms the service on `BOOT_COMPLETED` |
| DeviceAdmin policy XML | wired — `<force-lock />` only; no wipe, no password reset |
| Schedule editor UI | **A2 — wired.** Mon–Sun rows, presets (Night Owl / Early Bird / Weekend Flex), lock-duration chip group, save + activate, validates HH:MM format |
| Bot poll loop | **A2 — wired.** Verifies Ed25519 sig on each `BotMessage` using canonical-JSON preimage matching desktop byte-for-byte. Dispatches all v2 message kinds. Replay defense via `lastConsumedSeq` |
| AccessibilityService for app blocking | **A2 — wired.** `AppBlockerService` bounces non-allowlisted foreground apps back to home during curfew. Tight allowlist (system UI, Settings, dialer packages, launcher) |
| Friend Focus | **A3 — wired.** Opt-in `friendGated` per session; "Ask friend to release" via signed `request_focus_release` |
| Uninstall request flow | **A3 — wired.** See above |
| Self-healing daemon | **not started** — still pending from v1 |

## Threat model differences from macOS / Windows

If you're reading this expecting "Friend Lock on Android = Friend Lock on
macOS but on a phone," it's mostly true — same bot, same Ed25519 wire,
same friend-held password — but the **enforcement primitive** is weaker.

- **No `shutdown` equivalent.** Android user apps cannot power the device off.
  Enforcement = repeated `lockNow()`. The user can still unlock with their PIN,
  but they can't open the locked apps (we don't intercept app launches yet —
  see "AccessibilityService" above for the planned next step).
- **DeviceAdmin is revocable.** The user can go to Settings → Security → Device
  admin apps and turn NightOwl off at any time. Without **Device Owner** mode
  (which requires factory reset + provisioning), we can't prevent this.
  Bypass-resistance comes from the **friend-held password gating uninstall**,
  not from kernel-level lockdown. This is the same trust model as macOS/Windows;
  the OS just gives us fewer tools.
- **Doze + battery optimization may delay enforcement ticks.** On an idle
  device past Android 6, the 60-second tick may stretch to 5–15 minutes.
  Users will be told to whitelist NightOwl under Battery Optimization. The
  curfew-window check is forgiving (it catches "we should be in curfew now")
  so a delayed tick still triggers a lock, just later than intended.
- **No equivalent of macOS's `chown root`.** The schedule + identity files
  live in app-private storage. A rooted device can read them; a non-rooted
  one cannot from other apps. Same caveat as `lockScheduleFile()` being a
  no-op on Windows (see `CLAUDE.md` § v3 W1 decisions).

## Build prerequisites

You need:

- **Android Studio** Hedgehog 2023.1.1 or newer (for Kotlin 1.9.24 + Compose
  Compiler 1.5.14 compatibility). Download: https://developer.android.com/studio
- **Android SDK 34** (Android 14) — installed automatically by Android Studio
  on first sync.
- **JDK 17** — Android Studio ships an embedded one; the project pins
  `JavaVersion.VERSION_17`.

If you'd rather build from the command line on macOS without Android Studio:

```bash
# Install via Homebrew
brew install --cask android-commandlinetools
# Tell Gradle where the SDK is
echo "sdk.dir=$HOME/Library/Android/sdk" > packages/android/local.properties
# Accept SDK licenses (one-time)
sdkmanager --licenses
sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

## Build + install

```bash
cd packages/android
./gradlew assembleDebug          # outputs app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper JAR isn't committed (intentionally — it's binary). Generate
it once with `gradle wrapper --gradle-version 8.7` from your machine.

## First-run on device

1. Open the **NightOwl** app from the launcher.
2. Tap **Permissions → Grant** next to "Device admin". Confirm the system
   permission screen ("Allows NightOwl to lock the screen during curfew
   hours..." from `strings.xml`). Tap **Activate**.
3. Tap **Permissions → Grant** next to "App blocker (Accessibility)". Settings
   opens to the Accessibility list; find **NightOwl** and turn it on. Confirm
   the warning. (Without this, curfew only re-locks the screen between PIN
   unlocks — apps will still open during the gaps.)
4. Tap **Generate pair code**. The app talks to the Worker and shows an 8-char
   pair code in the **Friend Lock** card.
5. Hand that code to your locker via Telegram (regular DM, not the bot).
6. Locker DMs the bot: `/pair <CODE>` then `/setpassword <PW>`. The Android
   poll loop pulls each message within ~30s; you'll see the pairing phase
   advance `enrolled → awaiting_password → active` in the Status card.
7. In the **Schedule** card, configure each day or tap a preset (Night Owl /
   Early Bird / Weekend Flex). Pick a lock duration (1 / 3 / 7 / 14 / 30 days).
   Tap **Save schedule** then **Activate**. Activate is gated on:
   - Device admin granted
   - Friend has set the password (phase = `active`)
   - No unsaved schedule edits
8. Tap **Arm enforcement service**. A persistent notification appears:
   "NightOwl is watching · Curfew enforcement is armed."
9. When curfew fires, the screen locks. PIN unlock works (this isn't Device
   Owner mode), but it **re-locks the instant you finish unlocking** (a
   `USER_PRESENT` receiver — a quick PIN unlock otherwise left a usable window on
   phones), plus a ~5s backup tick, AND any non-allowlisted app you launch bounces
   back to home (where the accessibility service stays bound).

## OEM quirks — Xiaomi / MIUI (and other aggressive skins)

NightOwl has been metal-tested on a **Xiaomi Mi 9 Lite (Android 10/11, MIUI)** — full log + per-device matrix in **[`DEVICE-TESTING.md`](./DEVICE-TESTING.md)**. Aggressive OEM skins (MIUI, One UI, ColorOS…) fight sideloaded apps that use Device Admin + Accessibility, so a few extra steps are required or enforcement silently won't fire.

**Installing past Play Protect:**
- Play Protect hard-blocks the APK ("App blocked", often only an **OK** button on Android ≤12). Disable it briefly: **Play Store → profile → Play Protect → gear → turn off "Scan apps with Play Protect"**, install, then turn it back on. (Installing via `adb install` skips this entirely.)

**Granting Accessibility (the app blocker):**
- Android 13+: if the toggle is greyed, App info → ⋮ → **"Allow restricted settings."**
- Android ≤12 on MIUI (no "restricted settings"): **Developer options → "Turn off MIUI optimization"** → reboot → then enable NightOwl under Accessibility.
- **Reality check:** MIUI often won't keep the accessibility service *bound* (it shows enabled but `dumpsys accessibility` reports `Bound services:{}`), so the per-app blocker is unreliable on Xiaomi. The **Device-Admin screen-lock is the dependable enforcement layer** there; accessibility app-blocking is best-effort.

**Keeping enforcement alive (critical — or the curfew won't fire overnight):**
MIUI freezes background apps. Set all of these for NightOwl:
- **Autostart → ON**
- **Battery saver → No restrictions**
- Lock the app in **Recents** (long-press the card → lock icon)

A self-healing watchdog (`AlarmManager`, lives in the system so it survives the process being killed) re-arms the service within ~15 min if MIUI kills it anyway — but the settings above prevent the kill in the first place. The **● ARMED** status in the app is your at-a-glance health check.

**What no app can defend on a non-rooted phone:** the user can still force-stop NightOwl or revoke Device Admin / Accessibility in Settings. Bypass-resistance comes from the friend-held password (gating a clean uninstall) + the instant-relock deterrent — not a kernel lock. Closing that gap needs **Device Owner** mode (factory-reset provisioning), out of v4 scope.

## Distribution plan

- **Sideload first** — distribute via direct APK download. GitHub Release
  asset, same shape as the Windows W1 release (`v3.0.0-alpha.1`). Add an
  `/install` extension that detects "Android" in the user agent and serves
  the APK URL instead of the Windows installer. (Bot doesn't know user agent
  today; this requires either a client-side hint or just listing both URLs.)
- **F-Droid second** — once we're confident the build is reproducible and
  the threat model is documented honestly.
- **Google Play eventually** — apps that lock users out get extra scrutiny.
  Likely needs to be filed under the parental-control / digital-wellbeing
  category and may require a privacy review. Defer until v4.x is mature.

## Roadmap

- **A1** (`8215ba1`) — tracer-bullet scaffold. Compiles, installs, locks the
  screen during curfew. Schedule UI + poll loop + uninstall request UI all
  stubbed.
- **A2** — Schedule editor UI + bot poll loop + AccessibilityService for
  per-app blocking during curfew. Real friend can pair, set password,
  and trigger active enforcement end-to-end. Tag: `android-v0.2.0-alpha.1`
  (pending metal validation).
- **A3** (current) — Uninstall request flow + 72h non-cancellable emergency
  cooldown + Friend Focus port (solo + friend-gated) + user-managed allowlist.
  Tag: `android-v0.3.0-alpha.1` (pending metal validation). See
  `changes/A03-uninstall-cooldown-friend-focus-allowlist.md`.
- **A4** — F-Droid build reproducibility + signed release APK + the
  `/install` bot command serves the APK. Real-device validation gating.
- **A5** (`android-v0.3.4` → `0.3.6-alpha.1`) — **first real-device validation**
  (Xiaomi Mi 9 Lite, MIUI) + MIUI fixes + enforcement hardening: instant-relock on
  unlock, ● ARMED indicator, manual focus timer, self-healing watchdog, clean
  post-expiry stand-down. See [`DEVICE-TESTING.md`](./DEVICE-TESTING.md) and
  `changes/A05-metal-validation-miui-fixes.md`.
