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

## A05.1 — self-healing watchdog (v0.3.5-alpha.1)

The metal test exposed the real flaw: on MIUI the foreground service gets killed while idle and `START_STICKY` isn't honored, so the curfew silently stops until someone re-arms by hand. A schedule lock that needs manual re-arming isn't a real lock (the long-carried "self-healing daemon" TODO from v1).

Fix — an `AlarmManager`-based watchdog (new `Watchdog.kt` + `WatchdogReceiver.kt`):
- `setAndAllowWhileIdle` alarm every ~15 min. Alarms live in the system AlarmManagerService, **not the app process**, so they keep firing after the OS kills NightOwl.
- Each tick: if `EnforcementService.armed` is false (service down), restart it; always reschedule the next tick. Self-perpetuating across process deaths.
- `setAndAllowWhileIdle` chosen deliberately: fires through Doze, no `SCHEDULE_EXACT_ALARM` permission, and qualifies for the alarm-fired foreground-service-start exemption on Android 12+.
- Kicked off from `EnforcementService.onStartCommand` (arming) and re-armed in `BootReceiver` (reboot cancels alarms). `WatchdogReceiver` declared `exported="false"`.

**Verified on the Mi 9 Lite:** `dumpsys alarm` shows `*walarm*:com.nightowl.WATCHDOG_TICK` registered (RTC_WAKEUP, broadcast PendingIntent); the receiver fires (`am broadcast … result=0`) and the `!armed` guard correctly no-ops when the service is already up. Could not force a full kill→restore over adb because MIUI blocks the shell from stopping the FGS — but the registered alarm is exactly the mechanism that catches a real MIUI kill.

Known minor wart: the watchdog keeps the FGS alive even after a lock legitimately expires (no active-schedule check, to keep the FGS start inside the alarm exemption window). Acceptable for an always-on enforcement tool; refine later if needed.

## A05.2 — post-expiry service stand-down (v0.3.6-alpha.1)

The watchdog made enforcement immortal — including after a lock legitimately ends, leaving a zombie foreground service + persistent notification. Fixed so the service stands down cleanly when there's genuinely nothing left to enforce:

- New `Schedule.isLockExpired(nowMs)` (true once an active lock's `lockEndDate` is in the past) in `ScheduleStore.kt`.
- `EnforcementService.tickLoop`: when the lock period has ended it sets `active = false` (the immutability window is over, so deactivation is allowed), and when **neither an active lock nor a live focus** remains it cancels the watchdog, `stopForeground(STOP_FOREGROUND_REMOVE)`, and `stopSelf()`.
- **Critically NOT a stand-down trigger:** a daytime gap outside the curfew window — `active` is still true then, so the service stays alive and ready for tonight. Verified on the Mi 9 Lite: with the live 7-day lock (end date in the future), the service stayed running across an 8s observation, i.e. did not erroneously stand down.
- `enforcingNow()` (the instant-relock check) also respects expiry now.

Re-arming after a new lock reschedules the watchdog and restarts the service. versionCode 8→9, 0.3.5→0.3.6-alpha.1.

## A05.3 — regression fix: instant-relock fired 24/7 (v0.3.7-alpha.1)

The A5.2 cleanup refactor changed `enforcingNow()` (the instant-relock predicate) from `curfewActive(sched)` to `sched.active && !isLockExpired()`. That conflated "a lock is armed" with "we should be locking **right now**" — so during an active multi-day lock the screen re-locked on *every* unlock, all day, not just inside the curfew window. Surfaced on the Mi 9 Lite at 16:48 local with an evening curfew: the phone re-locked the instant you unlocked it, hours before curfew.

**Fix:** `enforcingNow()` reverts to `curfewActive(sched) || focusing` (the v0.3.5 logic). The tick loop was always correct (it used `curfewActive`); only the `USER_PRESENT` receiver's predicate was wrong. Verified on device — at 16:48 (outside the window) unlocking no longer re-locks; curfew-window enforcement is unchanged. versionCode 9→10, 0.3.6→0.3.7-alpha.1.

**v0.3.6-alpha.1 is broken — do not ship; superseded by v0.3.7.** Lesson: "armed" ≠ "enforce now." Any new enforcement trigger must gate on the current curfew/focus window, not the lock's armed state.

## Distribution
- Builds are `app/build/outputs/apk/release/app-release.apk` (release-signed, non-debuggable). Latest: **v0.3.5-alpha.1** (versionCode 8) with the watchdog. Tags `android-v0.3.4-alpha.1` and `android-v0.3.5-alpha.1`; the GitHub release asset behind the bot's `/install android` link is kept pointed at the latest build (clobbered on the `android-v0.3.0-alpha.1` asset path so the live bot link needs no redeploy).
