# NightOwl Android — Device Testing Log

Real-hardware validation for the Android port. The enforcement layer is OEM-sensitive (Device Admin + Accessibility behave very differently across skins), so "compiles + installs" is not "works." This file is the running record of what's actually been run on metal, what worked, and the per-OEM gotchas. Keep it updated whenever a new device is tested.

See also: install steps in [`README.md`](./README.md) (§ "OEM quirks"), and the engineering writeup in [`../../changes/A05-metal-validation-miui-fixes.md`](../../changes/A05-metal-validation-miui-fixes.md).

## Compatibility matrix

| Device | OS / skin | Build tested | Screen-lock (Device Admin) | App-blocker (Accessibility) | Self-heal (watchdog) | E2E friend-lock | Date |
|---|---|---|---|---|---|---|---|
| Xiaomi Mi 9 Lite | Android 10/11, MIUI | `0.3.6-alpha.1` | ✅ reliable | ⚠️ flaky (MIUI unbinds it) | ✅ alarm registered | ✅ pair→setpw→7-day lock | 2026-05-26 |
| _macOS/Windows_ | _(desktop, not Android)_ | — | n/a | n/a | n/a | ✅ (separate) | — |

Legend: ✅ works · ⚠️ partial/unreliable · ❌ broken · — n/a.

## What "tested" means here — the E2E checklist

A device counts as validated only when this whole loop runs on it. Reproduce in order:

1. **Install** the release APK (`adb install -r …` over USB bypasses Play Protect; or sideload + clear the Play Protect block).
2. **Device Admin** granted (Permissions card → Grant → Activate).
3. **Accessibility** ("App blocker") enabled (may need the OEM workaround below).
4. **Battery / autostart** set so the OS won't freeze the service (see MIUI section).
5. **Pair**: generate code on device → friend `/pair <CODE>` → `/setpassword <pw>` → Status card reaches **`active`**.
6. **Activate** a schedule with a lock duration → Status shows **Lock active: yes until <date>**.
7. **Arm** the enforcement service → **● ARMED** + "NightOwl is watching" notification.
8. **Enforce — screen lock:** during a curfew/focus window, lock the screen, unlock with PIN → it should **re-lock the instant you finish unlocking** (and every ~5s as backup).
9. **Enforce — app block:** open a non-allowlisted app → it should bounce to home (depends on Accessibility staying bound — unreliable on MIUI).
10. **Self-heal:** confirm the watchdog alarm is registered: `adb shell dumpsys alarm | grep WATCHDOG_TICK`.
11. **Survives reboot:** reboot → service re-arms (BootReceiver), watchdog reschedules.

Useful adb probes (USB debugging on):
```bash
adb shell dumpsys activity services com.nightowl        # is EnforcementService foreground?
adb shell dumpsys accessibility | grep -i nightowl      # Enabled vs Bound services
adb shell dumpsys device_policy | grep -i nightowl      # Device Admin active?
adb shell dumpsys alarm | grep WATCHDOG_TICK            # watchdog registered?
```

## Per-device findings

### Xiaomi Mi 9 Lite — Android 10/11, MIUI (validated 2026-05-26)

First end-to-end metal validation in the project. **Result:** the friend-lock works; the screen-lock enforcement is reliable; the accessibility app-blocker is not. Every step needed an OEM workaround.

**Install:** Play Protect hard-blocked the APK with only an **OK** button (no "Install anyway" on this Android version). Had to **disable "Scan apps with Play Protect"** in the Play Store, install, then re-enable. (`adb install` avoids this.)

**Accessibility grant:** there is **no "Allow restricted settings"** on Android < 13, so the usual A13+ unlock didn't exist. The working path was **Developer options → "Turn off MIUI optimization" → reboot**, then enable NightOwl under Accessibility.

**Accessibility reliability:** even once enabled, MIUI would not keep the service **bound** — `dumpsys accessibility` showed `Enabled services:{…NightOwl…}` but `Bound services:{}`, so the per-app blocker fired intermittently and then stopped (MIUI killing/refusing the bind). **Conclusion: on MIUI, treat the accessibility app-blocker as best-effort; rely on the Device-Admin screen-lock.**

**Screen-lock:** reliable once Device Admin was granted and the foreground service was armed. The original flat 60-second tick felt like a non-event on a phone (quick PIN unlock → ~60s of free scrolling), which drove the **instant re-lock on `USER_PRESENT`** fix — that made it genuinely enforce.

**Keeping the service alive:** MIUI froze the foreground service while idle and ignored `START_STICKY`, so enforcement silently stopped until manual re-arm. Two layers fixed it: the OEM keep-alive settings (Autostart + Battery No-restrictions + lock-in-recents) and the **`AlarmManager` self-healing watchdog** that re-arms within ~15 min even after a process kill.

**Other quirks:** the foreground-service notification is `IMPORTANCE_LOW`/silent, so arming looked like "nothing happened" though the service was running. `adb` could **not** write secure settings (`settings put secure …` → permission denied) — MIUI gates that behind "USB debugging (Security settings)" + a Mi account, so the accessibility rebind had to be done on-device.

## What to expect by OEM tier (general guidance)

- **Stock / Pixel / Android One:** closest to the happy path. Accessibility stays bound; foreground services survive; `setAndAllowWhileIdle` alarms fire on time. Play Protect still warns but usually offers "Install anyway."
- **Samsung (One UI):** generally cooperative; "Allow restricted settings" exists (A13+); battery optimization needs whitelisting for overnight reliability.
- **Xiaomi (MIUI/HyperOS), Oppo/Realme/OnePlus (ColorOS), vivo (FuntouchOS):** aggressive. Expect the full ritual — Play Protect disable, MIUI-optimization/restricted-settings dance, Autostart + battery whitelist, and a flaky accessibility bind. The screen-lock + watchdog are what make it usable here.

## Known ceiling (all non-rooted devices)

NightOwl uses Device Admin + Accessibility, both **revocable by the user in Settings**, and the app can be **force-stopped** (which also cancels the watchdog alarm until the app is next opened). There is no way to prevent this without **Device Owner** mode (factory-reset provisioning), which is out of v4 scope. Bypass-resistance therefore comes from the **friend-held password** (gating a clean uninstall) + the **instant-relock deterrent**, not a kernel-level lock. It's a consensual accountability tool, strongest when both people are bought in.
