# A2 — Schedule editor + bot poll loop + AccessibilityService app blocker

**Branch:** `feat/v4-android-alpha`
**Android `versionName`:** `0.1.0-alpha.1` → `0.2.0-alpha.1` (`versionCode` 1 → 2)
**Scope:** Android-only. **Zero changes** to `packages/{shared,desktop,bot,daemon}` or root `package.json`. The macOS `v1.0.0` and Windows `v3.0.0-alpha.1` release artifacts are unaffected.

## What this milestone delivers

The three items the A1 README labeled as "stubbed" / "deferred to A2":

1. **Per-day schedule editor UI** — Compose card with Mon–Sun rows, time pickers, presets, lock-duration chip group, save + activate buttons. Activate is gated on Device Admin granted **and** friend delegation in `active` phase.
2. **Bot poll loop** — recurring caller of `BotClient.poll()` running inside the foreground service. Verifies each `BotMessage` against the bot's hardcoded Ed25519 pubkey using a Kotlin-side canonical-JSON that matches `packages/bot/src/crypto.ts` byte-for-byte. Dispatches `pair_complete`, `password_hash`, `friend_revoked`, `uninstall_decision`, `focus_release_decision`. Advances `lastConsumedSeq` for replay defense.
3. **AccessibilityService app blocker** — new `AppBlockerService` listens for `TYPE_WINDOW_STATE_CHANGED`. During curfew, non-allowlisted foreground packages are bounced back to home via `GLOBAL_ACTION_HOME`. Allowlist is a tight set of system surfaces + dialer packages for emergency calls.

## File-by-file

### New files

- `packages/android/app/src/main/java/com/nightowl/CanonicalJson.kt`
  - `canonicalJson(JsonElement): String` — keys sorted at every depth, JS-`JSON.stringify`-compatible string escapes.
  - `botMessagePreimage(pairingId, seq, kind, payload): String` — `v2|<pairingId>|<seq>|<kind>|<canonicalJson(payload)>` mirror of the desktop's signing format.

- `packages/android/app/src/main/java/com/nightowl/PollLoop.kt`
  - `PollLoop(client, store).runForever()` — coroutine that polls every 30s pre-active, every 5min once active or revoked.
  - Per-message: verify sig with `Identity.verifyBotSignature`, drop-on-fail, drop-if-replay. Dispatch by kind. Always advance `lastConsumedSeq` even on unknown/malformed kinds to avoid getting stuck.

- `packages/android/app/src/main/java/com/nightowl/AppBlockerService.kt`
  - `AppBlockerService : AccessibilityService` — caches the schedule via a `StateFlow` so each accessibility event is a lock-free read instead of a DataStore round-trip.
  - `ALLOWLIST` includes NightOwl itself, system UI, Settings, several dialer packages, Pixel + Samsung launchers.
  - `companion object`'s `isEnabled(ctx)` and `openSettings(ctx)` — UI uses these to surface the toggle without subclassing into the activity.

- `packages/android/app/src/main/java/com/nightowl/HomeViewModel.kt`
  - Extracted from `MainActivity.kt`. Now owns editor-state separately from saved schedule (`editorDays` vs `savedSchedule`) so unsaved edits are preserved while the bot poll loop is writing to the same `Schedule` from another coroutine.
  - `validateEditorDays` rejects half-set day rows, invalid HH:MM, and equal start/end (would be a 24h curfew).
  - `activateSchedule` enforces the three preconditions: device admin granted, friend delegation in `active` phase, no unsaved edits.

- `packages/android/app/src/main/java/com/nightowl/ScheduleEditor.kt`
  - `@Composable ScheduleEditor` — stateless wrt persistence; all writes route through the ViewModel.
  - `DayRow` — Switch + two `OutlinedTextField`s for HH:MM. Monospace text style so digit alignment is consistent.

- `packages/android/app/src/main/res/xml/accessibility_service_config.xml`
  - `typeWindowStateChanged` only. `canRetrieveWindowContent=false` so the prompted permission scope reads as "read which app is in foreground" rather than "read screen contents" — honest to the threat model.

### Modified

- `packages/android/app/src/main/java/com/nightowl/ScheduleStore.kt`
  - `DelegationState` expanded to match `packages/shared/src/delegation.ts` shape: `friendName`, `friendChatId`, `pairedAt`, `lastConsumedSeq`, `phase` (enum), `passwordHash`, `passwordSetAt`, `lastUninstallDecision`, `lastFocusReleaseDecision`, `friendRevokedAt`.
  - New `DelegationPhase` enum mirrors the desktop's phase names exactly so log-cross-referencing across platforms isn't confusing.
  - `Presets` object — Night Owl / Early Bird / Weekend Flex hardcoded; matches feel of the macOS web UI's preset buttons. Not copied byte-for-byte from `server.js` because the macOS UI is Vanilla JS in a different layer.
  - `lockEndDateIn(days: Int): String` — `Instant.now().plus(days, DAYS).toString()`.
  - `DAY_KEYS` constant — shared list to keep day-ordering stable across editor render + curfew check.

- `packages/android/app/src/main/java/com/nightowl/Identity.kt`
  - **Bug fix carried over from A1:** `verifyBotSignature` was decoding with `Base64.NO_WRAP or Base64.URL_SAFE`, but the bot encodes with standard-alphabet `btoa` (`+/`). Changed to `Base64.NO_WRAP` alone. Also added a `sig.size != 64` short-circuit so a malformed signature returns false instead of throwing inside Tink.

- `packages/android/app/src/main/java/com/nightowl/EnforcementService.kt`
  - Added a second coroutine `pollLoop()` alongside the existing `tickLoop()`. Each starts at most once per service lifetime.

- `packages/android/app/src/main/java/com/nightowl/MainActivity.kt`
  - Refactored from a single `Home` composable into sectioned cards: Status, Permissions, Friend Lock pairing, Schedule editor, Enforcement service, Messages.
  - Whole screen now in a `verticalScroll` — the editor + 7 day rows wouldn't fit on small phones otherwise.
  - The old inline ViewModel + HomeState moved to `HomeViewModel.kt`.

- `packages/android/app/src/main/AndroidManifest.xml`
  - Added `<service android:name=".AppBlockerService">` with `BIND_ACCESSIBILITY_SERVICE` permission and the meta-data pointer to the config XML.

- `packages/android/app/src/main/res/values/strings.xml`
  - Added `accessibility_service_description` + `accessibility_service_summary` (shown by Android in the Settings → Accessibility list).

- `packages/android/app/build.gradle.kts`
  - `versionCode` 1 → 2, `versionName` 0.1.0-alpha.1 → 0.2.0-alpha.1.

## Wire-compat invariants pinned this milestone

The Android poll loop reuses the v2 wire format. If any of these drift, signature verification will fail silently and the poller will spin without state-transitioning. Tests need to live in `packages/shared` for desktop; Android can't import them, so we eyeball-mirror.

- **Preimage format**: `v2|<pairingId>|<seq>|<kind>|<canonicalJson(payload)>`. Source of truth: `packages/bot/src/crypto.ts:botMessagePreimage`.
- **Canonical JSON**: sorted keys at every depth, JS-stringify primitive serialization. The Kotlin implementation in `CanonicalJson.kt` mirrors this rule-for-rule. If a future bot payload includes a Unicode codepoint above U+FFFF, the Kotlin version's UTF-16 surrogate handling must be re-verified against `JSON.stringify`.
- **Bot pubkey**: `c67a4785231869d571763e2f9f0a9c8a0f8c7480ffbe70a56259a50e4b849431` — hardcoded in `Identity.kt:BOT_PUBKEY_HEX`, matches `packages/shared/src/identity.ts:BOT_PUBKEY_HEX`.
- **Message kinds**: `pair_complete`, `password_hash`, `friend_revoked`, `uninstall_decision`, `focus_release_decision`. New kinds need explicit handling on Android.

## Threat-model addendum

App blocking via AccessibilityService is **stronger than A1 but weaker than the macOS `killall` path**:

- **The user can disable the accessibility service from Settings.** Without Device Owner provisioning we cannot prevent this. The UI surfaces "App blocker: ✓/✗" as a status indicator, but does not refuse to activate the schedule when accessibility is off — A1's screen-lock behavior is still a valid fallback. Activation copy makes this explicit.
- **Allowlist is intentionally tight.** Dialer + Settings are the only "real" apps allowed during curfew, on the principle that emergency calls and OS-level config (including granting/revoking NightOwl's own perms) must always be reachable. A future user-editable allowlist screen is a candidate for A3 but defaults must stay restrictive.
- **No window-content reading.** The service's config declares `canRetrieveWindowContent="false"`. We only need package names. If a future feature wants per-screen heuristics (e.g. "block in-app browsers but not the OS browser shell"), the prompted-permission scope has to widen and the README threat model needs a new bullet.

## Deferred to A3

- **Uninstall request flow + 72h emergency cooldown.** Poll loop already lands `uninstall_decision` into `DelegationState.lastUninstallDecision`; A3 wires the "Request uninstall" button + cooldown timer + the gate on the daemon's un-arm path.
- **Friend Focus port.** `focus_release_decision` is landed similarly but no Focus session UI exists yet.
- **User-managed allowlist screen.** Hardcoded for now.
- **Real-device validation.** No metal-testing on a phone in this commit; the README + this changelog are honest about that.
- **Activate flow without delegation** (self-set lock). Currently we hard-gate Activate on phase=`active`. A "no friend, password-only" path is consistent with the macOS v1 mode but not yet wired.

## Versioning / branch / deploy strategy

- All A2 code lives in `packages/android/` on `feat/v4-android-alpha`. Nothing in this milestone touches the npm workspaces, so a future `npm run package:mac` or `npm run package:win` against this branch produces identical bytes to what `main` would.
- After landing, tag as `android-v0.2.0-alpha.1`. Distinct namespace from the desktop's `v1.0.0` / `v3.0.0-alpha.1` so deploy streams don't get confused.
- macOS users on `v1.0.0` are unaffected — the npm `dist/` is unchanged, no shared bundles exist between the two worlds.
