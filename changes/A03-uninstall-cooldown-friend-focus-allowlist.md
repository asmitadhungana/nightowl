# A3 — uninstall flow + 72h emergency cooldown + Friend Focus + user allowlist

**Branch:** `feat/v4-android-alpha`
**Android version:** `versionName` 0.2.0-alpha.1 → 0.3.0-alpha.1, `versionCode` 2 → 3.
**Scope:** Android-only. Zero edits to `packages/{shared,desktop,bot,daemon}`. macOS `v1.0.0` and Windows `v3.0.0-alpha.1` artifacts unaffected.

## What this milestone delivers

The four A3 items from the roadmap, all wired and reasoning-through-the-code:

1. **Uninstall request flow** — "Ask friend to release" button calls `BotClient.requestUninstall(pairingId, reqId)`, persists `pendingUninstallReqId` on the delegation, surfaces gate verdict, and exposes "Uninstall now" once the friend /approves. Mirrors desktop M6.
2. **72h emergency cooldown** — non-cancellable timer. UI hard-confirms with an `AlertDialog` before starting. Countdown shown in hours+minutes. `uninstallGate` automatically flips to `Allowed` when `emergencyCooldownRemainingMs(s) <= 0`.
3. **Friend Focus port** — opt-in friend-gated focus sessions. Solo focus is uncancellable (matches v1 contract). Friend-gated focus has the same Ask/Cancel/EndNow shape as the uninstall flow but routed through `request_focus_release` + `focus_release_decision` message kinds. Mirror of desktop M7.
4. **User-managed allowlist** — Compose card lets the user add package names to `Schedule.userAllowlist`, which `AppBlockerService` union's with `HARDCODED_ALLOWLIST` at every accessibility event. **Defaults are non-removable** — system UI, Settings, dialer, launcher stay protected.

## File-by-file

### New files

- `packages/android/app/src/main/java/com/nightowl/DelegationGates.kt`
  - `sealed class DelegationGate { Allowed, Blocked }` mirroring the desktop's TypeScript discriminated union.
  - `uninstallGate(s, nowMs)` — all 8 branches from `packages/shared/src/delegation.ts` mirrored.
  - `focusReleaseGate(s, focus)` — same shape; solo focus is the explicit "uncancellable by design" branch.
  - `emergencyCooldownRemainingMs(s, nowMs)`, `canStartEmergencyUninstall(s)`, `isDelegated(s)`, `EMERGENCY_COOLDOWN_MS` constant (72h in ms).

- `packages/android/app/src/main/java/com/nightowl/FocusStore.kt`
  - `FocusSession` data class with `active`, `startedAt`, `endsAt`, `durationMinutes`, `friendGated`, `pendingReleaseReqId`, `lastReleaseDecision`. Helpers `isElapsed(now)` and `remainingMs(now)`.
  - `FocusStore(ctx)` — separate DataStore namespace `nightowl_focus`. Independent of `ScheduleStore` so the daemon can read focus without parsing the schedule.

- `packages/android/app/src/main/java/com/nightowl/UninstallCard.kt`
  - `@Composable UninstallCard(state, onRequestUninstall, onCancelPending, onStartCooldown, onSoftUninstall)`. Hidden when no delegation exists. Gate verdict shown. Cooldown countdown rendered when active. 72h cooldown gated by hard-confirm `AlertDialog`.

- `packages/android/app/src/main/java/com/nightowl/FocusCard.kt`
  - `@Composable FocusCard(state, onStart, onRequestRelease, onCancelPending, onEndEarly)`. Idle: duration chip group (15/25/45/60/90 min) + optional friend-gated checkbox (only visible when phase=`active`). Active: countdown + friend-release controls if friend-gated, else "uncancellable" copy.

- `packages/android/app/src/main/java/com/nightowl/AllowlistCard.kt`
  - `@Composable AllowlistCard(state, onInputChange, onAdd, onRemove)`. Lists user-added packages, package-name input + Add button, removes individually. Only mounted when accessibility is granted (otherwise meaningless).

### Modified

- `packages/android/app/src/main/java/com/nightowl/ScheduleStore.kt`
  - `DelegationState` gains `pendingUninstallReqId: String?` and `emergencyUninstallStartedAt: String?` (mirrors desktop's `delegation.ts`).
  - `Schedule` gains `userAllowlist: List<String> = emptyList()`.

- `packages/android/app/src/main/java/com/nightowl/BotClient.kt`
  - New `suspend fun requestFocusRelease(pairingId, reqId, focusMinutes, focusStartedAt)`. Wire-format mirror of `POST /desktop/request-focus-release` (preimage `request_focus_release|<pairingId>|<reqId>|<ts>`).

- `packages/android/app/src/main/java/com/nightowl/PollLoop.kt`
  - Constructor accepts an optional `focusStore: FocusStore?`.
  - `applyUninstallDecision` now clears `pendingUninstallReqId` iff the decision is FOR the in-flight request (matches desktop's "out-of-band approvals are recorded but don't fire").
  - `applyFocusReleaseDecision` writes the verdict to BOTH delegation history AND `FocusStore` (so `focusReleaseGate` sees it).

- `packages/android/app/src/main/java/com/nightowl/EnforcementService.kt`
  - Tick loop now also enforces during an active, non-elapsed focus session. Elapsed focus sessions are auto-cleared in-loop so the user's UI reflects reality without app re-open.
  - Poll loop constructs `FocusStore` and passes it to `PollLoop` so focus-release decisions land in the right place.

- `packages/android/app/src/main/java/com/nightowl/AppBlockerService.kt`
  - Caches both `Schedule` and `FocusSession` via separate `StateFlow`s, subscribed at `onServiceConnected`.
  - Per-event blocking is `(curfewing OR focusing) AND pkg !in (HARDCODED_ALLOWLIST + sched.userAllowlist)`.
  - `ALLOWLIST` renamed to `HARDCODED_ALLOWLIST` and bumped to `internal` visibility so `HomeViewModel.addAllowlistEntry` can validate that user input doesn't shadow a default.

- `packages/android/app/src/main/java/com/nightowl/HomeViewModel.kt`
  - New state fields: `focus`, `uninstallGate`, `focusReleaseGate`, `emergencyCooldownRemainingMs`, `allowlistInput`.
  - Init flow now combines schedule + focus into a single state update path so concurrent writes from PollLoop (schedule) + countdown ticks (focus) both reflect in UI.
  - New actions: `requestUninstall`, `cancelPendingUninstallRequest`, `startEmergencyCooldown`, `softUninstall`, `startFocus`, `requestFocusRelease`, `cancelPendingFocusRelease`, `endFocusEarly`, `setAllowlistInput`, `addAllowlistEntry`, `removeAllowlistEntry`.
  - `softUninstall` is "release the lock + clear delegation"; the user then completes APK removal manually via Settings → Apps → NightOwl. Android can't self-uninstall without a system intent + user confirmation; the UI copy makes this explicit.

- `packages/android/app/src/main/java/com/nightowl/MainActivity.kt`
  - Three new cards inserted in the home scroll: `UninstallCard`, `FocusCard`, `AllowlistCard` (last gated on `accessibilityActive`).

- `packages/android/app/build.gradle.kts` — versionCode 2→3, versionName 0.2.0-alpha.1→0.3.0-alpha.1.

## Load-bearing decisions pinned this milestone

If a future request would relax any of these, push back.

- **72h cooldown is non-cancellable.** Same invariant as desktop M6. Hard-confirm dialog before starting; no "actually never mind" button. Defangs hostile-friend scenarios.
- **Solo focus is uncancellable.** Matches v1 contract. The UI's "End focus now" button is gated by `focusReleaseGate` which returns `Blocked` for solo sessions regardless of UI state.
- **Friend approval is scoped per kind.** Uninstall-decision does NOT cross-bless focus-release, same as desktop M7. `lastUninstallDecision` and `lastFocusReleaseDecision` are separate fields.
- **User-allowlist is additive only.** `Schedule.userAllowlist` extends but cannot shrink `HARDCODED_ALLOWLIST`. The user cannot remove the dialer (emergency calls) or Settings (granting/revoking NightOwl perms) from the allowlist by editing this list.
- **"Uninstall now" on Android is a soft-uninstall.** Releases the lock + clears delegation + stops focus, but does not remove the APK. The user completes APK removal via Settings — Android disallows self-uninstall without explicit user confirmation. Documented in the UI copy.

## What this does NOT do (deferred)

- **Real-device validation.** A3 has not been driven on physical hardware. Tag `android-v0.3.0-alpha.1` only after metal E2E pair → setpassword → schedule → request-uninstall → /approve → soft-uninstall flow succeeds.
- **Allowlist package picker.** Add input is freeform text; no autocomplete from installed packages. UI says "look it up in Settings → Apps." Future enhancement.
- **Lock-screen view.** Desktop has a dedicated locked-mode UI showing countdown + progress. Android shows the schedule editor + status + uninstall card on one scrollable home — no separate locked screen. Acceptable for alpha; UX polish if real users find it confusing.
- **Notification when the friend /approves.** Today the user has to check the app. Adding a system notification on `uninstall_decision` arrival is a 30-line follow-up.
- **Self-set lock path (no friend).** Activate still gates on `phase=active`. A password-only mode mirroring macOS v1 stays out of scope.

## Versioning / branch / deploy strategy

- All work in `packages/android/` on `feat/v4-android-alpha`.
- After real-device validation, tag `android-v0.3.0-alpha.1`.
- macOS v2.0.0 stream (on `feat/v2-friend-lock-alpha`) is unaffected — the polish bundle from the previous session deploys to real users independently of A3.
- Cross-branch impact: zero. The bot Worker accepts `request-focus-release` from any signed client (including desktop M7 and Android A3); KV records on the bot are pairing-scoped and don't conflict.
