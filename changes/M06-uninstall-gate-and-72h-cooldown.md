# M6 — Uninstall gate + 72h emergency cooldown + bot deploy hardening

- **Date:** 2026-05-10
- **Branch:** `feat/v2-friend-lock-alpha`
- **Commit:** uncommitted at session end (17 files modified, 1 new file, ~1k LOC)
- **Tests:** 95/95 green (was 85; +10 covering `uninstallGate`)
- **Builds:** all four packages clean (`npm run -ws --if-present build`)

## What this milestone closes

The v2 alpha had Friend Lock pairing built end-to-end (M1–M5) but the
"friend actually holds the keys" promise was load-bearing-but-unbuilt:

- `daemon:uninstall` checked the user's password, but in friend-lock mode the
  user does not have the password — this made uninstall effectively a brick wall
  rather than a friend-gated approval.
- The 72h emergency cooldown (the safety net for friend-vanishes / hostile-friend
  / Telegram-down) had predicates in shared but no code path to start it.
- `/revoke` was a valid `DelegationPhase` enum value with no bot handler.
- The Worker was deployed but `TG_BOT_TOKEN` was missing from
  `wrangler secret list`, so the bot could receive Telegram updates and not
  reply to them.

M6 ships all of the above except the manual `wrangler secret put TG_BOT_TOKEN`
step, which is documented in `RUNBOOK.md §8`.

## What changed (by file)

### Bot (Cloudflare Worker)

- **`packages/bot/src/types.ts`** — added `UninstallReqStatus`, `UninstallRequest`,
  `RequestUninstallBody`, `RequestUninstallResponse`. Extended `MessageKind` from
  `'pair_complete' | 'password_hash'` to also include `'friend_revoked'` and
  `'uninstall_decision'`.
- **`packages/bot/src/kv.ts`** — new `ureq:` KV namespace prefix (TTL 7 days, longer
  than any practical lock). New helpers `getUninstallRequest` / `putUninstallRequest`.
- **`packages/bot/src/telegram.ts`** — `sendMessage` now returns
  `Promise<SendMessageResult | null>` instead of `Promise<void>` so M6 can grab the
  Telegram `message_id` of the friend's prompt (back-compat for all existing call
  sites that just `await` and discard).
- **`packages/bot/src/routes/tg-webhook.ts`** — three new commands:
  - `/revoke` — friend opts out of approving uninstall. Bot moves pairing
    `status` → `'revoked'`, increments `botSeq`, pushes a signed `friend_revoked`
    inbox message. Lock continues to `lockEndDate`; UI surfaces the 72h cooldown
    more prominently.
  - `/approve <REQID>` and `/deny <REQID>` — friend acts on a pending uninstall
    request. UUID-shape validation; idempotent (second `/approve` on the same
    `reqId` returns "already approved"); enforces `pairing.friendChatId === chatId`
    so requests aren't decidable by the wrong account. On success: pushes a
    signed `uninstall_decision` inbox message.
  - Helper `notifyFriendOfUninstallRequest` — DMs the friend the request context
    + the literal `/approve <reqId>` / `/deny <reqId>` strings to copy-paste.
- **`packages/bot/src/routes/request-uninstall.ts`** *(new)* — `POST
  /desktop/request-uninstall`. Verifies the desktop's Ed25519 signature against the
  pubkey stored on the pairing record. Idempotent on `reqId` to prevent the desktop
  from spamming the friend if the request is retried on flaky network.
- **`packages/bot/src/index.ts`** — wired `/desktop/request-uninstall` route.

### Shared (`@nightowl/shared`)

- **`packages/shared/src/delegation.ts`** — `DelegationState` extended with
  `lastUninstallDecision: { reqId; verdict; decidedAt } | null` and
  `friendRevokedAt: string | null`. New `uninstallGate(schedule, nowMs?)` predicate
  is the **single source of truth** for "may the user uninstall right now?" — used
  by both the desktop API gate and the renderer UI. Returns `{ allowed, reason }`;
  `reason` is the user-facing string. Branch logic:
  - non-delegated → allowed (caller does the password check)
  - pre-active phases → allowed (user can cancel pairing)
  - active + decision is approved → allowed
  - active + cooldown elapsed → allowed
  - active + cooldown in flight → blocked, reason includes hours remaining
  - active + decision is denied → blocked, "try again or start cooldown"
  - active + pending request → blocked, "waiting on friend"
  - revoked + no cooldown → blocked, "friend stepped away — start cooldown"
- **`packages/shared/src/__tests__/delegation.test.ts`** — 10 new tests for
  `uninstallGate` covering every branch. 85 → 95 tests passing.

### Desktop main process

- **`packages/desktop/src/main/friendlock.ts`** — orchestration for the new flow:
  - `requestUninstall()` — mints a UUIDv4 reqId, signs `request_uninstall|...`,
    POSTs to the bot, persists `pendingUninstallReqId` on the delegation, tightens
    polling cadence so the decision arrives fast.
  - `startEmergencyCooldown()` — sets `emergencyUninstallStartedAt`. **Cannot be
    cancelled** by design (see "paths not taken").
  - `getUninstallGateStatus()` — snapshot for the renderer; cheap, safe per UI tick.
  - New dispatchers `dispatchFriendRevoked` and `dispatchUninstallDecision` for
    the two new signed message kinds.
  - New IPC events: `friendlock:uninstallDecision`, `friendlock:emergencyCooldownChanged`.
- **`packages/desktop/src/main/api.ts`** — `handleDaemonUninstall` now branches on
  `isDelegated(s)`: in delegated mode the password is ignored and `uninstallGate` is
  the only gate. On successful uninstall, `delegation` is cleared so a future re-pair
  starts clean. Three new IPC handlers wired:
  `friendlock:requestUninstall`, `friendlock:startEmergencyCooldown`,
  `friendlock:getUninstallGate`.
- **`packages/desktop/src/main/index.ts`** — startup warning in packaged builds
  when `BOT_URL` matches localhost/127.x (almost certainly means
  `NIGHTOWL_BOT_URL` was forgotten). Points at `RUNBOOK.md §8`.
- **`packages/desktop/src/preload.cjs`** — exposed the three new invoke channels
  + two new event subscriptions on `window.nightowl.friendlock.*`.

### Desktop renderer

- **`packages/desktop/src/renderer/index.html`** — new "Need to uninstall?" card
  on the locked screen, with three buttons (Ask friend / Start cooldown /
  Uninstall now). State A modal copy updated — used to say "72h cooldown — Phase 2"
  back when it was unbuilt; now lists it as a real escape route.
- **`packages/desktop/src/renderer/style.css`** — `.uninstall-state` + `.muted` +
  `allowed`/`cooldown`/`denied` color variants, matching the existing dark theme.
- **`packages/desktop/src/renderer/app.js`** — `setupUninstallCard` (one-time wire)
  + `refreshUninstallCard` (called on every locked-screen tick). Renders the right
  button set + state copy depending on gate result. Hard `window.confirm` before
  starting cooldown, with the explicit "this CANNOT be cancelled" wording.
  Subscribes to `onUninstallDecision` and `onEmergencyCooldownChanged` for live
  updates without waiting for the 1s tick.

### Docs

- **`CLAUDE.md`** — relaxed "no external services" with a v2 carve-out narrowly
  scoped to Telegram + Worker. Added M6 to the Milestone log. Extended "Problems
  faced" and "Paths intentionally NOT taken" with the M6 decisions.
- **`RUNBOOK.md`** — new §8: bot bring-up checklist (the missing `TG_BOT_TOKEN`
  step + webhook + smoke test).

## What this does NOT do (deferred)

- Set the `TG_BOT_TOKEN` Worker secret. This is a one-line manual step the user
  has to run because it requires the bot token from @BotFather. See
  `RUNBOOK.md §8` for the exact command.
- Run a real Telegram E2E. The Worker is deployed and the desktop is wired, but
  enroll → pair → setpassword → request-uninstall → approve → uninstall has not
  been driven against a live bot account. This is the natural next thing once
  the token is set.
- Add bot integration tests. `packages/bot` still has `"test": "echo 'no bot
  tests yet'"`. The new request-uninstall + revoke + approve/deny paths would be
  good first targets — `vitest` against a mock `KVNamespace` is the obvious
  approach.
- Bake a hosted Worker URL into `BOT_URL`. Deferred until the self-hosting story
  is settled; M6 added the packaged-build startup warning as a soft alternative.

## Operational gotchas discovered during M6 bring-up

- **`wrangler secret put` reads from STDIN, not argv.** Putting the value on
  the same line (`wrangler secret put TG_BOT_TOKEN <value>`) errors out with
  `Unknown argument: <value>` AND wrangler logs the full argv to
  `~/Library/Preferences/.wrangler/logs/wrangler-*.log` on error — the token
  ends up in a file. If you ever see this happen: revoke the token via
  @BotFather (`/revoke`), delete the log, clear shell history. The
  `RUNBOOK.md §8` and `packages/bot/README.md` both warn about this now.

## Things future sessions need to know

- `uninstallGate` is the only place where "may the user uninstall right now?"
  logic lives. If a future feature needs to ask this question, import the
  predicate; do not duplicate the branch logic.
- The 72h cooldown is **not cancellable**. If a future request says "give the
  user a 'never mind' button," refuse — that defangs the safety net under
  social pressure (the whole reason it exists).
- `delegation` is cleared on successful delegated uninstall. This means a fresh
  re-pair after uninstall starts in `phase: 'enrolled'` with no leftover state.
  The 7-day TTL on `ureq:` records cleans up old decisions on the bot side.
- `sendMessage` now returns `Promise<SendMessageResult | null>` (was
  `Promise<void>`). Existing code that just `await`s the call is unchanged.
  Anything new that needs the `message_id` should grab `r?.result?.message_id`.
- `BOT_URL` in `packages/shared/src/identity.ts` defaults to
  `http://localhost:8787` and is overridden by `NIGHTOWL_BOT_URL`. Don't change
  the default to point at a single hosted Worker — it would break self-hosting.
  Use the startup warning in `main/index.ts` if you need to make the misconfig
  louder.
- `BOT_PUBKEY_HEX` in `identity.ts` is the hex-encoded raw 32-byte Ed25519
  public key the desktop verifies against. Rotating it is a coordinated event
  (deploy bot with new key → ship a new desktop release → retire the old key
  from the bot). Don't change it casually.
