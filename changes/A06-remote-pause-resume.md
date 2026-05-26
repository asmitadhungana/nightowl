# A06 — remote /pause + /resume (friend-controlled enforcement switch)

**Branch:** `feat/v6-circles-alpha`. **Version:** Android `0.3.7 → 0.3.8-alpha.1` (versionCode 10→11).
**Status: BUILT, not yet deployed/E2E-tested.** Bot deploy is a production action awaiting explicit go-ahead; Android side built but not installed (phone was disconnected at install time).

## Why

The locker and the user live apart. If the lock ever misfires (see the A05.3 regression) while the friend isn't physically present, there was no remote way to lift it — only the user's on-device escapes (Safe Mode, force-stop). This adds a **friend-only remote switch**: the friend texts the bot, the user's device pauses/resumes enforcement. Within the friend's existing powers (they hold the keys); the user cannot trigger it.

## How it works

- **Bot** (`/pause`, `/resume`): friend-initiated commands. `handleEnforcementPause` finds the friend's active pairing (`findActivePairingByFriend`), queues a **signed** `enforcement_pause` message (`{ paused: bool, at }`) — same sign/enqueue path as `friend_revoked`/`uninstall_decision`. New `MessageKind 'enforcement_pause'`.
- **Android**: `PollLoop.applyEnforcementPause` sets `Schedule.enforcementPaused`. `EnforcementService` (tick + the `USER_PRESENT` instant-relock via `enforcingNow`) and `AppBlockerService` both gate on `!enforcementPaused`. The service keeps running + polling while paused, so `/resume` always reaches it. Status card shows a "⏸ Paused by your locker" line.
- **Poll cadence tightened**: active-phase poll 5min → **60s**, so a remote `/pause` (and uninstall approvals) land within ~a minute instead of five. Modest battery cost for the responsiveness a remote locker needs.

## Safety / invariants

- Friend-only: the signal only arrives **bot-signed** (verified against `BOT_PUBKEY_HEX`); the user can't set `enforcementPaused`. Pause does NOT touch the schedule or lock period — it's a temporary lift, not a deactivation.
- Paused = "armed but not enforcing": service stays alive (so resume works); it does NOT trigger the A05.2 stand-down (that's gated on `!active`, and pause leaves `active` true).
- Latency bound: only reaches the phone while it's polling (i.e. while armed) — which is exactly when you'd need to pause it. If MIUI killed the app, nothing's enforcing to pause anyway.

## Remaining to ship

1. **Deploy the bot** (`wrangler deploy` from `packages/bot`) — additive (new commands + kind); existing flows unchanged; tsc clean. Production action — explicit go-ahead required.
2. **Install Android `0.3.8` on the device** (`adb install -r`, or reinstall from the `/install` link once the hosted asset is bumped). A `0.3.7` phone ignores `enforcement_pause` harmlessly (unknown-kind → advances seq).
3. **E2E test**: friend `/pause` → `dumpsys` / behavior shows `enforcementPaused=true`, no locking; `/resume` restores. Then bump the hosted `/install` asset + tag `android-v0.3.8-alpha.1`.
