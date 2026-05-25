# C01 — Circles Phase 1: multi-device Accounts foundation

**Branch:** `feat/v6-circles-alpha`
**Theme:** Expand NightOwl from the 1:1 Friend Lock into the Circles design (multi-device + k-of-n social accountability). This milestone ships **Phase 1** of that design: the multi-device `Account` foundation — the most mission-true piece ("schedule lock enforcement no matter what" across *all* of a person's devices, not just one).

Full design + load-bearing decisions: `changes/CIRCLES-design.md` (the approved /office-hours doc).

## Why this first

A curfew that locks only the phone is theater if the laptop stays open at 2am. Phase 1 makes the lock span every device under one account, and judges compliance across all of them so a second screen can't defeat it (design R5). It is also the substrate the k-of-n circle layer (Phase 2) builds on — a dyad is just the `{1,1}` case.

## What shipped (and how it's verified)

| Layer | What | Verification |
|---|---|---|
| `@nightowl/shared` | `account.ts` — Account/device model + attach/detach/heartbeat + `curfewCompliance` + streak + `buildCurfewReport` | **20 new unit tests, all pass; 122/122 shared tests green; `tsc` clean** |
| `@nightowl/bot` | `Account` persistence + `JoinCode` + `curfew_report` MessageKind + KV layer + 4 signed endpoints | **`tsc --noEmit` clean.** NOT integration-tested (no wrangler run), **NOT deployed** |
| Android | `Account.kt` — Kotlin mirror of the tested shared logic | **`compileReleaseKotlin` clean.** SCAFFOLD — not yet wired into enforcement |

## File-by-file

### New
- `packages/shared/src/account.ts` — pure types + predicates. `Account` = bot-assigned `accountId` + N `AccountDevice`s. `attachDevice`/`detachDevice` (dup + cap + last-device guards), `recordHeartbeat`, `curfewCompliance` (R5: any non-heartbeating-or-not-enforcing registered device = coverage gap, full stop), `nextStreak`, `buildCurfewReport` (minimal witnessing payload). `MAX_DEVICES_PER_ACCOUNT=10`, `HEARTBEAT_STALE_MS=15min` (Doze-tolerant).
- `packages/shared/src/__tests__/account.test.ts` — 20 tests: attach dup/cap/bad-hex, detach last-device/unknown, heartbeat isolation, compliance never-reported/stale-boundary/not-enforcing/mixed-second-screen/malformed-ts, streak, report.
- `packages/bot/src/routes/account.ts` — 4 Ed25519-signed handlers: `create`, `join-code` (minted by an existing device = R3 confirmation), `attach` (new device redeems a one-time 5-min code), `heartbeat`. Logic mirrors shared; kept self-contained so the Worker bundle pulls in no node built-ins.

### Modified
- `packages/shared/src/index.ts` — export `account.js`.
- `packages/bot/src/types.ts` — `MessageKind` gains `'curfew_report'` (additive; clients already ignore unknown kinds — verified). `Pairing.accountId?` (additive link). New `Account`/`AccountDevice`/`JoinCodeRecord` + endpoint wire types.
- `packages/bot/src/kv.ts` — `acct:` + `jcode:` namespaces; `getAccount`/`putAccount`/`get|put|deleteJoinCode`.
- `packages/bot/src/index.ts` — route the 4 `/desktop/account/*` paths.
- `packages/android/.../Account.kt` — Kotlin mirror (compile-verified scaffold).
- `.gitignore` — ignore `*.apk` / `*.exe` (binaries go to Releases, never the public repo).

## Load-bearing decisions honored (from the design)

- **R5 — "kept" = every registered device heartbeats `enforced`.** Silence (powered-off is indistinguishable from force-stopped over the relay) is a coverage gap, never silently "kept." This is the mission guarantee.
- **R3 — device attach needs an existing-device-minted join code** (5-min TTL, one-time, burned on use).
- **R4 — device *detach* is a release-class action.** `detachDevice` is the pure transition only; the doc requires the caller to gate it behind the account's release threshold. Phase 1 does not expose an unauthorized detach path.
- **Additive migration.** The 1:1 `Pairing` is untouched (only an optional `accountId` added). Existing macOS/Windows/Android builds keep working; unknown `MessageKind`s are ignored (verified in `PollLoop.kt` else-branch + desktop `default:`).

## NOT done / deferred (honest scope)

- **Not deployed.** The bot changes are typecheck-only and intentionally NOT pushed to the live Worker — that Worker serves the real Friend Lock and must not change un-validated. Deploy after review + a wrangler-dev integration pass.
- **Client enforcement not wired.** `Account.kt` is a compile-verified scaffold; the enforcement loop still operates per-pairing. Wiring all-device polling + the heartbeat sender + account onboarding UI is the Phase 1 client integration step, gated on A3 real-device validation.
- **Witnessing fan-out is Phase 2.** `curfew_report` kind is registered; the device-signed k-of-n approval tally + fan-out to opted-in witnesses is Phase 2 (per design R1/R2/R8).
- **No real-device validation.** Same gate as all A* milestones.

## Next steps

1. wrangler-dev integration test of the 4 account endpoints; then deploy the additive bot changes.
2. Wire `Account.kt` into `EnforcementService`/`PollLoop` (all-device schedule poll + heartbeat sender).
3. `/plan-eng-review` for the Phase 2 device-signed threshold tally before building circles.
