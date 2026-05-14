# V05 (future) — Mobile-as-controller for desktop NightOwl

**Status:** design note, not yet started. Captured during the v2.0.0 / v4 A2 session on 2026-05-14 in response to the user asking "can we make NightOwl a mobile app that controls macOS?" Sequencing decision: finish A3 (Android self-enforcement) first, then revisit v5.

This is a future architecture spec, not an implementation plan. The intent is to make sure the **decisions are pinned** so that whoever picks this up next session doesn't redo the analysis from scratch.

## What the user asked for

> "Can we make NightOwl a mobile app, it will be used to control the macOS lockups and scheduling and will have the same functionality as the macOS desktop app, but it can be used as a mobile app."

Reading: the **phone is the renderer; the macOS daemon remains the enforcer.** Same surfaces as the desktop UI (schedule edit, lock activation, focus mode, Friend Lock setup) but operated from the phone over the network.

This is distinct from v4 (Android-as-enforcer-of-itself). The two could coexist (the same Android app curfews itself AND controls the user's macOS), but it's a separate concern.

## Why this is feasible

The Cloudflare Worker bot already implements a signed-message relay between devices. It speaks **device-A enrolls, device-B sends a signed message to device-A's inbox, device-A polls and verifies**. That's the same shape we need for phone↔desktop.

Specifically, what's already in place:

- `BOT_URL` + `BOT_PUBKEY_HEX` + `canonicalJson` byte-format are shared across macOS, Windows, and Android (Kotlin mirror).
- The desktop already polls the bot inbox every 10–60s via `friendlock.ts`.
- The Android client (`packages/android/app/src/main/java/com/nightowl/BotClient.kt`) already speaks the v2 wire format.
- Ed25519 identity exists on both ends — extending verification to a second pubkey (the phone's) is a small wire change.

## Architecture (proposed)

Three new layers, smallest delta first:

### 1. Bot Worker additions

New KV namespace: `phonelink:<pairingId>` — separate from the existing friend-lock `pairing:<id>` records to avoid confusion. Shape:

```ts
interface PhoneLink {
  pairingId: string;
  desktopPubkeyHex: string;
  phonePubkeyHex: string;
  pairedAt: string;
  desktopSeq: number;  // bot → desktop inbox cursor
  phoneSeq: number;    // bot → phone inbox cursor
}
```

New endpoints:

- `POST /phone/enroll` — phone registers its pubkey, gets a 8-char pair code
- `POST /desktop/phonelink/pair` — desktop's existing poll loop also checks for inbound pair-code submissions
- `POST /phone/command` — phone signs a command, bot relays to desktop inbox
- `POST /phone/poll` — phone polls for desktop-originated status updates
- `POST /desktop/phonelink/poll` — desktop polls for phone-originated commands (likely fold into existing `/desktop/poll` by adding new message kinds)

New signed message kinds (in `MessageKind`):

- Phone → desktop: `phone_command` with payload discriminating on `action: "save_schedule" | "activate" | "deactivate" | "start_focus" | "end_focus" | "request_uninstall" | "start_emergency_cooldown"`
- Desktop → phone: `desktop_status` snapshot — schedule, lock state, focus session, delegation phase

~600 LOC, ~2 days.

### 2. Desktop main process additions

In `packages/desktop/src/main/`, a new orchestrator `phonelink.ts` parallel to `friendlock.ts`:

- Polls for `phone_command` messages, verifies signatures against the registered phone pubkey, dispatches to the **same IPC handlers the renderer uses** (`schedule:save`, `schedule:activate`, `friendlock:requestUninstall`, etc.).
- The phone is treated as **just another renderer**. No special privileges. All gates apply equally — `uninstallGate` still requires friend approval, etc. Phone cannot bypass Friend Lock.
- Pushes `desktop_status` snapshots after every state change so the phone UI stays fresh.

~400 LOC, ~1 day.

### 3. Mobile UI

**Android:** the existing A2 Compose UI is ~70% reusable. Pivot from "configure my Android curfew" to "configure my macOS curfew" by:

- Replace the local `ScheduleStore` writes with `BotClient.sendCommand("save_schedule", ...)`.
- Replace `EnforcementService` with a passive `StatusPoller` that reads desktop snapshots.
- Remove `AppBlockerService` and `lockNow()` paths — they're meaningless when the phone is just a controller.

~3 days. Reuses pairing wizard, schedule editor, friend-lock card.

**iOS:** net-new SwiftUI app. ~5 days minimum + Apple Developer Program ($99/yr) + App Store review (parental-control category is notoriously slow — plan 4–6 weeks total wall-clock from start to ship). Defer until Android-controlling-macOS is validated.

## Load-bearing decisions

If a future request would relax any of these, push back.

- **Phone is just another renderer.** It does not get privileged access to bypass any gate the desktop renderer is subject to. The moment Activate fires, the phone can no longer Deactivate without Friend Lock approval — same as the user sitting at the laptop.

  Why this matters: the entire point of NightOwl is that the user does not have an escape hatch. If the phone is privileged, the phone becomes the escape hatch.

- **All commands are Ed25519-signed end-to-end.** A compromised Worker can drop messages but cannot forge them. Same threat model as Friend Lock.

- **Phone↔desktop pairing is a one-time bootstrap.** Phone has one paired desktop; desktop has one paired phone. Multi-device is a separate concern (v5.1).

- **Phone CANNOT initiate Friend-Lock uninstall on the user's behalf.** The phone's "Request uninstall" button hits the same `/desktop/request-uninstall` flow as the desktop UI — friend must still /approve in Telegram. No shortcut.

- **Pre-Activate, the phone has full control over schedule + lock duration + friend setup.** Post-Activate, the phone respects `uninstallGate` and `focusReleaseGate` the same way the desktop does.

## Paths intentionally NOT taken (when this gets built)

- **Direct phone-to-laptop network connection.** mDNS / local-WiFi pairing avoids the Worker hop but breaks the moment WiFi changes or the user is off-network. The bot relay is the same shape that already works for Friend Lock; reuse it.

- **Separate authentication scheme for phone↔desktop.** Reuse Ed25519 identities. Adding TLS-cert-pinning or shared-secret schemes adds a security surface without adding security.

- **Real-time push from bot to desktop/phone.** Workers don't natively do WebSocket-out; long-poll is fine for "lock activated" + "decision arrived" cadence. Optimize only if user-perceived latency is unacceptable.

- **Letting the phone change the friend mid-lock.** Same invariant as desktop: friend cannot be swapped during an active delegation.

- **iOS first.** Android already has a working v4 codebase; iOS is greenfield + App Store review wait. Land Android-controlling-macOS first, then port to iOS when the wire protocol is settled.

- **Cross-device "control my friend's computer."** Out of scope — Friend Lock already gives a friend control over the user's computer via Telegram. Mobile-as-controller is for the **owner's own machine**, not someone else's.

## Total estimated scope

| Layer | Effort |
|---|---|
| Bot Worker phonelink namespace + endpoints | ~2 days |
| Desktop `phonelink.ts` orchestrator | ~1 day |
| Android UI pivot from A2 surfaces | ~3 days |
| Bidirectional sync + diagnostics | ~1 day |
| iOS app (SwiftUI, optional, deferred) | ~5 days + 4–6w App Store review |

**Android-only path: ~2 weeks. With iOS: ~4 weeks + review.**

## Pre-flight before starting v5

Before any v5 work begins, the following must be true:

1. **A3 metal-validated.** Android v4 needs to run on a real device through pair → setpassword → curfew → uninstall flow before we add new responsibilities to that codebase.
2. **v2.0.0 deployed to real macOS users.** Otherwise we're building a controller for software that doesn't have users yet.
3. **A clear answer to "what does the phone show when the desktop is offline?"** Decide between "last-known status with a stale indicator" vs "blocks the UI until reachable." Probably the former; pin it before implementation.

## References

- Friend Lock wire format: `packages/shared/src/identity.ts`, `packages/bot/src/crypto.ts`, `changes/M06-uninstall-gate-and-72h-cooldown.md`
- Android wire mirror: `packages/android/app/src/main/java/com/nightowl/{Identity,BotClient,CanonicalJson,PollLoop}.kt`
- Desktop poll orchestrator: `packages/desktop/src/main/friendlock.ts`
- Threat model invariants: `CLAUDE.md` § v2 "Load-bearing invariants"
