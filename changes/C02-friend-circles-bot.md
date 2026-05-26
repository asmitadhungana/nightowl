# C02 — Friend Circles (bot-managed accountability groups)

**Branch:** `feat/v6-circles-alpha`. **Status: BUILT + unit-tested; bot deploy deferred** (gated on the same go-ahead as A06 /pause — production Worker that gates a live lock).

## What this is

A small group of friends who keep each other on track, formed and managed through the Telegram bot. Each member runs their own NightOwl lock; the circle is where they group up and (next layer) see each other's curfew streaks/compliance. This is the **social/visibility** layer the user asked for — deliberately separate from the k-of-n unlock-multisig in `CIRCLES-design.md`, so joining/leaving a circle never weakens anyone's lock.

Members are keyed by **Telegram chat id** (the immutable identifier the 1:1 Friend Lock already uses). v1: one circle per person.

## What shipped

| Layer | What | Verification |
|---|---|---|
| `@nightowl/shared` | `circle.ts` — `Circle`/`CircleMember` model + roster logic (create/join/leave, dedup, member cap, creator-promotion on leave) | **11 new unit tests; 133/133 shared green; tsc clean** |
| `@nightowl/bot` | `Circle`/`CircleCodeRecord` types + KV (`circle:`/`ccode:`/`cmember:`) + `/createcircle`, `/joincircle`, `/circle`, `/leavecircle` | **tsc clean. NOT deployed.** |

## File-by-file

### New
- `packages/shared/src/circle.ts` — pure model + predicates: `makeCircle`, `addMember` (idempotent, capped at `MAX_CIRCLE_MEMBERS=12`), `removeMember` (promotes earliest remaining member to `creator` so a circle is never leaderless; empties → caller deletes), `findMember`/`isMember`/`memberCount`/`isEmpty`.
- `packages/shared/src/__tests__/circle.test.ts` — 11 tests: create, name trim/truncate, add (new/dup-noop/empty/cap), remove (known/unknown/creator-promotion/last-member-empties).

### Modified
- `packages/shared/src/index.ts` — export `circle.js`.
- `packages/bot/src/types.ts` — `Circle`/`CircleMember`/`CircleCodeRecord` + `MAX_CIRCLE_MEMBERS`/`MAX_CIRCLE_NAME_LEN`.
- `packages/bot/src/kv.ts` — `getCircle`/`putCircle`/`deleteCircle`, `getCircleCode`/`putCircleCode` (multi-use, 7-day TTL — friendly window to form a circle), `getMemberCircleId`/`setMemberCircle`/`clearMemberCircle` (member→circle index, one circle per person).
- `packages/bot/src/routes/tg-webhook.ts` — `/createcircle [name]` (mints a shareable join code), `/joincircle <code>`, `/circle` (roster), `/leavecircle` (with creator-promotion / auto-close). Roster ops inlined to keep the Worker bundle self-contained (mirrors `circle.ts`, same "duplicate the shape, not the import" rule as the account routes). Help text updated.

## Design notes

- **Social layer ≠ enforcement layer.** A circle is about visibility + mutual accountability, not holding each other's unlock keys. The k-of-n multisig (device-signed, in the enforcement path) stays a separate, later concern.
- **One circle per person (v1)** via the `cmember:` index — keeps `/circle` and `/leavecircle` O(1) and the UX simple. Revisit if multi-circle membership is wanted.
- **Join code is multi-use + 7-day TTL** (unlike the 5-min single-use pair code) — forming a circle isn't security-critical and friends join over days.

## Next layers (not built)
1. **Compliance sharing** — each member's device reports curfew kept/broke + streak (the `curfew_report` primitive scaffolded in `account.ts`); the bot fans it out to the circle (`/circle` shows everyone's streak; optional daily digest; nudges). This is where the circle becomes *accountability*, not just a roster.
2. **Deploy** — `/create|join|circle|leavecircle` go live with the same `wrangler deploy` as A06 /pause, on explicit go-ahead.
