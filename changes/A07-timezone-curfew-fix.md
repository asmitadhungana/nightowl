# A07 — curfew evaluated in UTC instead of device-local (timezone bug)

**Version:** Android `0.3.8 → 0.3.9-alpha.1` (versionCode 11→12). **Severity: high** — the curfew fired at the wrong hours on real hardware.

## Symptom (reported, Asia/Kathmandu, UTC+5:45)

A 7-day lock set for **23:00–05:00** did NOT lock at 23:00; it locked pre-dawn and stayed locked past 05:00 until ~09:45–10:45. That's a **+5:45h forward shift** of the whole window — the exact UTC↔Kathmandu offset.

## Root cause

`Schedule.timezone` defaulted to `"UTC"`, and `HomeViewModel` only replaced it when **blank** (`sched.timezone.ifBlank { defaultTimezone() }`) — `"UTC"` isn't blank, so the device zone never got stored. Enforcement then evaluated the window in UTC:
- `EnforcementService.curfewActive`: `LocalDateTime.now(zoneOf(sched.timezone))` → UTC.
- `AppBlockerService`: same.

UTC eval of a 23:00–05:00 window on a +5:45 device fires when local time ∈ [04:45, 10:45] — matching the report.

## Fix

Evaluate the curfew in the **device's local zone** (`ZoneId.systemDefault()`), not the stored `schedule.timezone`. The curfew is a local wall-clock bedtime, so device-local is both the fix and the correct semantic — and it repairs the **currently-locked** schedule (stored `"UTC"`) without rewriting it (it's immutable for the lock period).

- `EnforcementService.curfewActive` → `LocalDateTime.now(ZoneId.systemDefault())` (removed the now-dead `zoneOf`).
- `AppBlockerService` curfew check → `ZoneId.systemDefault()`.
- `Schedule.timezone` default `"UTC"` → `""` so the editor fills the device zone for future schedules (enforcement no longer depends on the stored value; keeps it honest).

## Verification

Root cause is conclusive (the +5:45 shift is the exact Kathmandu offset; the `"UTC"`-never-replaced path is confirmed in code). Device zone is Asia/Kathmandu, and `ZoneId.systemDefault()` reflects `persist.sys.timezone`, so the fix evaluates in Kathmandu. **Behavioral confirmation is the 23:00 window tonight** (locks on time; unlocks at 05:00, not ~10:45) — can't be observed mid-morning since both old/new agree the phone is unlocked then.

## Note / minor residual

Using device-local time means a user who changes the phone's timezone shifts their own curfew — a theoretical bypass, but changing the system clock is disruptive + noticeable, and far better than the UTC bug. Pinning to a fixed stored zone would prevent that but reintroduces the "stored zone is wrong" failure mode; deferred.
