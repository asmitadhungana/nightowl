# @nightowl/android — Android port (v4 alpha, tracer bullet)

This package is the Android port of NightOwl. It pairs with the same Cloudflare
Worker bot that the macOS and Windows builds use; the bot is OS-agnostic by
design (see `CLAUDE.md` § v2). What's platform-specific is the **enforcement**
layer, and that's where Android diverges materially from desktop.

## What this is

- **Standalone Gradle project** under `packages/android/`. NOT part of the npm
  workspace — Kotlin/Gradle and TypeScript/npm are two different worlds and we
  don't try to bridge them.
- **A1 milestone (this commit):** tracer-bullet scaffold. Enough Kotlin to
  open in Android Studio, hit Build, install an APK on a device, grant device
  admin, enroll with the bot, and see the screen lock when curfew fires. Not
  yet enough for a real friend to use.

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
| `POST /desktop/poll` | wired — method exists but no UI surface invokes it yet |
| `POST /desktop/request-uninstall` | sketched — method exists, no UI |
| Curfew schedule storage (DataStore) | wired — `ScheduleStore` reads/writes JSON; default empty |
| Curfew-time math (incl. overnight) | wired — `Schedule.isCurfewActive()` handles start≤end + start>end |
| Foreground service + 60s tick | wired — `EnforcementService` |
| `DevicePolicyManager.lockNow()` during curfew | wired |
| Boot persistence | wired — `BootReceiver` re-arms the service on `BOOT_COMPLETED` |
| DeviceAdmin policy XML | wired — `<force-lock />` only; no wipe, no password reset |
| **Schedule editor UI** | **stubbed** — UI shows pair code and status; no day-by-day curfew picker yet |
| **Bot poll loop** | **stubbed** — poll method exists, no recurring caller |
| **Friend Focus** | **not started** — M7 desktop feature not yet ported |
| **Uninstall request flow** | **not started** — `requestUninstall()` is callable but no UI button + no 72h cooldown UI |
| **AccessibilityService for app blocking** | **deferred** — A2 candidate; today we only lock the screen, we don't intercept individual apps |
| **Self-healing daemon** | **not started** — still pending from v1 |

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
2. Tap **Grant device admin** → confirm the system permission screen. The screen
   says "Allows NightOwl to lock the screen during curfew hours..." (from
   `strings.xml`). Tap **Activate**.
3. Tap **Generate pair code** → app talks to the Worker, receives an 8-char
   pair code, shows it on screen.
4. Hand that code to your locker via Telegram (regular DM, not the bot).
5. Locker DMs the bot: `/pair <CODE>` then `/setpassword <PW>`.
6. (Currently stubbed) When the schedule editor is wired up, you'd set
   per-day curfew here. For now you can hand-write the schedule JSON to
   DataStore via adb if you want to test enforcement.
7. Tap **Arm enforcement service**. A persistent notification appears:
   "NightOwl is watching · Curfew enforcement is armed."
8. When curfew fires, the screen locks. PIN unlock works (this isn't Device
   Owner mode), but the lock returns within 60 seconds.

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

- **A1** (this commit) — tracer-bullet scaffold. Compiles, installs, locks the
  screen during curfew. Schedule UI + poll loop + uninstall request UI all
  stubbed.
- **A2** — Schedule editor + bot poll loop + AccessibilityService for
  per-app blocking during curfew (the missing "kill processes" equivalent).
- **A3** — Uninstall request flow + 72h emergency cooldown + Friend Focus.
- **A4** — F-Droid build reproducibility + signed release APK + the
  `/install` bot command serves the APK.
