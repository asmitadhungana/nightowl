# M7 — Friend Focus integration (Focus Mode + Friend Lock)

- **Date:** 2026-05-10
- **Branch:** `feat/v2-friend-lock-alpha`
- **Commit:** uncommitted at session end (15 files, ~700 LOC)
- **Tests:** 102/102 green (was 95; +7 covering `focusReleaseGate`)
- **Builds:** all four packages clean

## What this milestone adds

A **Friend Focus** session — opt-in per session — where the user's already-paired
friend holds the early-termination key. Solo Focus (today's behavior) keeps
working unchanged: uncancellable until the timer elapses. The new variant lets
the user start, say, a 90-minute focus session and ask the friend to /approve
ending it early via Telegram.

### Design choices (settled with user before implementation)

- **(b) Friend gates early termination, not the start.** Spontaneous focus
  is most of Focus Mode's value; gating the start would kill that.
- **Reuse existing delegation.** Same friend who holds the schedule-lock
  password is the same friend who can release a focus session. Multiple
  delegations / per-session friends is a v3 conversation.
- **Optional per session.** Solo Focus and Friend Focus coexist; the user
  picks per session via a checkbox on the focus card.
- **No 72h emergency cooldown for focus.** Sessions are short (max 8h
  per the existing validation). The natural fallback is "wait the timer
  out" — no explicit safety net needed.

## What changed (by file)

### Bot

- **`packages/bot/src/types.ts`** — new `ApprovalKind = 'uninstall' | 'focus_release'`
  discriminator on `UninstallRequest`. `MessageKind` extended with
  `focus_release_decision`. New wire types `RequestFocusReleaseBody` /
  `RequestFocusReleaseResponse`.
- **`packages/bot/src/kv.ts`** — `getUninstallRequest` defaults missing
  `kind` to `'uninstall'` so legacy KV records persisted before M7 still
  resolve correctly.
- **`packages/bot/src/routes/request-uninstall.ts`** — sets `kind: 'uninstall'`
  on new records.
- **`packages/bot/src/routes/request-focus-release.ts`** *(new)* — mirror of
  request-uninstall with `kind: 'focus_release'`, an extra
  `focusMinutes` + `focusStartedAt` payload for the friend's prompt context,
  and a different signature preimage (`request_focus_release|...`).
- **`packages/bot/src/routes/tg-webhook.ts`** — `/approve` and `/deny` now
  route to either `uninstall_decision` or `focus_release_decision` signed
  inbox messages based on the request's `kind`. Friend-facing reply copy
  diverges per kind. New `notifyFriendOfFocusReleaseRequest` helper for the
  focus prompt.
- **`packages/bot/src/index.ts`** — wired `POST /desktop/request-focus-release`.

### Shared

- **`packages/shared/src/types.ts`** — `FocusSession` extended with
  `friendGated`, `pendingReleaseReqId`, `lastReleaseDecision`. All optional
  for back-compat with v1 focus.json records.
- **`packages/shared/src/delegation.ts`** — new `focusReleaseGate(schedule, focus)`
  predicate, single source of truth for "may the user end this focus
  session early?" Mirrors `uninstallGate` shape; returns the same
  `UninstallGate` discriminated union (renamed type still fits — it's
  really an "approval gate").
- **`packages/shared/src/__tests__/delegation.test.ts`** — 7 new tests
  covering focusReleaseGate paths: solo refusal, no-pairing refusal,
  no-request, pending, approved, denied, and explicit "uninstall approval
  does not green-light focus release."

### Desktop main process

- **`packages/desktop/src/main/friendlock.ts`** —
  - New dispatcher `dispatchFocusReleaseDecision` for the new signed message
    kind. Updates `focus.json` (not `delegation`); guards against stale
    decisions arriving after the focus session ended.
  - New IPC orchestration: `requestFocusRelease`, `cancelPendingFocusRelease`,
    `endFocusEarly`, `getFocusReleaseGateStatus`.
  - New IPC event `friendlock:focusReleaseDecision` so the active-focus
    screen can react to /approve within ~1s.
- **`packages/desktop/src/main/api.ts`** —
  - `handleStartFocus` accepts `friendGated: boolean`; refuses friend-gated
    sessions when no delegation exists.
  - Wired four new IPC handlers for the focus-release flow.

### Desktop renderer

- **`packages/desktop/src/renderer/index.html`** —
  - New "🔒 Friend Focus" checkbox on the focus card. Hidden unless
    `delegation.friendName` is set.
  - New "Need out early?" card on the active focus screen with Ask /
    Cancel pending / End focus now buttons.
- **`packages/desktop/src/renderer/style.css`** — `.focus-friend-toggle`
  styling matching the existing dark theme.
- **`packages/desktop/src/renderer/app.js`** —
  - `setupFocus` shows the toggle conditional on delegation; passes
    `friendGated` to `startFocus`.
  - `showFocusActive` calls into a new `setupFocusReleaseCard` and
    refreshes it on every 1s tick + on the new IPC event.
  - `refreshFocusReleaseCard` mirrors the locked-screen pattern: solo
    sessions hide the card entirely; per-tick state reset prevents
    stuck button states across decision changes (same lesson learned
    from M6).

## What this does NOT do (deferred)

- **Re-pair before focus.** If no delegation exists when the user wants a
  Friend Focus, the toggle is hidden — no inline "pair a friend now"
  flow. They'd need to set up the schedule-lock pairing first.
- **Bot-side cancellation.** `cancelPendingFocusRelease` is local-only,
  same as `cancelPendingUninstallRequest`. The friend's prompt still sits
  there; if they /approve, dispatchFocusReleaseDecision sees the
  non-pending reqId and drops it.
- **Friend can /revoke just for focus.** `/revoke` revokes the entire
  delegation — they can't selectively step away from one feature. This
  is consistent with the asymmetric design.
- **Multi-session memory.** Each focus session is its own approval scope.
  An /approve on session A doesn't pre-bless session B. lastReleaseDecision
  is cleared with the focus session.

## Things future sessions need to know

- **`focusReleaseGate` and `uninstallGate` are kept separate on purpose.**
  They share the `UninstallGate` return type (poorly named — should
  really be `ApprovalGate` if we ever rename) but the verdict for one
  does NOT cross-bless the other. A single friend approval is scoped to
  the specific request kind. This is invariant — don't merge them.
- **`focus.json` now carries Friend Focus state.** The daemon still keys
  enforcement on `focus.active`; `friendGated` and `pendingReleaseReqId`
  are renderer/orchestration state and the daemon ignores them. Any
  daemon work should not need to know about Friend Focus at all.
- **Bot's `kind` field on UninstallRequest is the routing key.** When
  /approve <REQID> comes in, the bot looks up the record and uses
  `record.kind` to decide which signed message kind to push back. Add
  new approval kinds the same way: extend the enum, set the kind on
  the record, branch in `handleDecision`.
- **Worker needs redeploy** — new endpoint `/desktop/request-focus-release`,
  new approval routing in `/approve` `/deny`. Run `npx wrangler deploy`
  from `packages/bot/` after this lands.
