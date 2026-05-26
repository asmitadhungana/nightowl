# A05 — first real-device validation + MIUI fixes + enforcement hardening

**Branch:** `feat/v6-circles-alpha` (these are v4 Android fixes; they landed on the circles tip).
**Version:** `0.3.0-alpha.1` → `0.3.4-alpha.1` (versionCode 3 → 7), built + `adb install`-ed iteratively during a live debugging session on real hardware.

## The headline

**NightOwl's Android enforcement was validated on real hardware for the first time** — a **Xiaomi Mi 9 Lite (Android 10/11, MIUI)**, end-to-end:
pair → `/setpassword` → delegation phase **active** → **7-day friend-lock activated**, with the locker (friend) holding the password. The screen-lock enforcement works; the accessibility app-blocker is unreliable on MIUI (documented below).

## What we learned on metal (MIUI gotchas — worth baking into the README)

- **Play Protect hard-blocks the sideload** ("App blocked", only an **OK** button on Android 10/11) → must temporarily disable **Play Store → Play Protect → Scan apps**. ("Install anyway" doesn't appear on the hard-block.)
- **No "Allow restricted settings"** on Android < 13 (it's an A13+ feature) → grant the accessibility service via **Developer options → "Turn off MIUI optimization"** + reboot.
- **MIUI won't keep the accessibility service bound** — it enables but sits in `Binding services:{…}` / `Bound services:{}` (killed/refused), so app-bounce was intermittent then stopped. The **device-admin screen-lock is the dependable layer**; accessibility app-blocking is the soft, flaky one on aggressive OEMs.
- **The FGS notification is silent** (IMPORTANCE_LOW / pri=0) → "Arm" looked like "nothing happened" though the service was running.
- **`adb` can't write secure settings on MIUI** (needs "USB debugging (Security settings)" + a Mi account) — so the accessibility rebind had to be done on-device.
- For overnight reliability the service needs **Autostart ON + Battery "No restrictions" + lock-in-recents**, or MIUI freezes it while idle.

## Fixes shipped this session

### Enforcement hardening (the big one) — `EnforcementService.kt`
On a phone, a quick PIN unlock made the 60s lock tick feel like a non-event ("unlock, scroll for a minute"). Fixed:
- **Instant re-lock on unlock:** a `USER_PRESENT` `BroadcastReceiver` (registered via `ContextCompat.registerReceiver` + `RECEIVER_NOT_EXPORTED`) calls `lockNow()` the moment the keyguard is dismissed during an active curfew/focus. No usable window.
- **Adaptive tick:** `ENFORCING_TICK_MS = 5s` while enforcing (was a flat 60s), `IDLE_TICK_MS = 60s` otherwise to save battery.
- Extracted `enforcingNow()` / `curfewActive()` so the tick and the receiver share one definition.

### Armed-state indicator — `EnforcementService.kt` + `MainActivity.kt`
- `EnforcementService.armed: MutableStateFlow<Boolean>` (true in `onCreate`, false in `onDestroy`; resets with the process).
- `EnforcementCard` observes it: shows **● ARMED** (primary) / **● NOT ARMED** (error) + a "Re-arm" vs "Arm" button. Deliberately **not** an off-toggle — a one-tap disable would be a curfew bypass.

### Manual focus timer — `FocusCard.kt`
- Custom-minutes `OutlinedTextField` (numeric, 1–480, capped at 8h because solo focus is uncancellable) + "Start custom", alongside the 15/25/45/60/90 chips. Also fixed the stale "re-locks every 60s" copy.

### Friend Lock card text — `MainActivity.kt`
- `PairingCard` was hardcoded to "Already enrolled. Waiting for friend to /pair…" whenever a pairing existed — it never read the delegation phase, so it showed "waiting" even when fully **active**. Now phase-aware: active / paired / awaiting_password / revoked / enrolled / not-enrolled.

## Not changed / still true
- Soft-enforcement ceiling holds: the user can disable Device admin or force-stop the app in Settings (no Device Owner mode). Bypass-resistance = friend-held password gating clean uninstall + the deterrent of the instant-relock.
- Accessibility app-blocking remains best-effort on MIUI.

## Distribution
- New build is `app/build/outputs/apk/release/app-release.apk` (release-signed, non-debuggable, v0.3.4-alpha.1). Tag `android-v0.3.4-alpha.1`; the GitHub release asset behind the bot's `/install android` link updated to this build.
