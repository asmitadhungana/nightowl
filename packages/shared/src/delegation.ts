/**
 * NightOwl Friend-Lock Delegation State (v2)
 *
 * Pure types and small predicates. State is persisted as a field on `Schedule`
 * (see types.ts → Schedule.delegation). This module owns the *shape* and
 * lifecycle predicates; the orchestration logic (polling, IPC, side effects)
 * lives in packages/desktop/src/main/friendlock.ts.
 */

import type { Schedule, FocusSession } from './types.js';

/**
 * Lifecycle of a delegated lock.
 *
 *   enrolled         — desktop posted /desktop/enroll, has pairing_id + pair_code,
 *                      friend has not yet typed /pair on Telegram.
 *   paired           — friend successfully /pair'd; desktop knows their name.
 *   awaiting_password— same as `paired`, but friend has not yet /setpassword.
 *                      (We split phases so the UI can be specific.)
 *   active           — password hash arrived + verified + persisted; lock is live.
 *   revoked          — friend /revoke'd. Lock continues until lockEndDate; only
 *                      escape path is the 72h emergency cooldown (Phase 2).
 */
export type DelegationPhase = 'enrolled' | 'paired' | 'awaiting_password' | 'active' | 'revoked';

export interface DelegationState {
  /** Bot-issued UUID for this pairing. Stable across the delegation lifetime. */
  pairingId: string;
  /** Friend's display name (Telegram first_name). Null until phase >= 'paired'. */
  friendName: string | null;
  /**
   * Friend's Telegram chat ID, surfaced to UI for "Locked by [name]" copy.
   * Stored as string to avoid JS number-precision issues with large IDs.
   */
  friendChatId: string | null;
  /** ISO timestamp when /pair completed. */
  pairedAt: string | null;
  /**
   * Highest bot_seq the desktop has consumed from this pairing's inbox.
   * Replay defense — any incoming message with seq <= lastConsumedSeq is dropped.
   */
  lastConsumedSeq: number;
  /** Current lifecycle phase. */
  phase: DelegationPhase;
  /**
   * UUIDv4 of the in-flight uninstall request awaiting friend approval.
   * Null whenever no request is pending or the most recent one is decided.
   */
  pendingUninstallReqId: string | null;
  /**
   * ISO timestamp when the user started the 72h emergency uninstall cooldown.
   * Null if cooldown is not active. Once started it cannot be cancelled — that
   * keeps the safety net from being defanged by a hostile-friend scenario.
   */
  emergencyUninstallStartedAt: string | null;
  /**
   * Most recent uninstall decision the friend has issued. Cached on the desktop
   * so the user can act on it immediately and so a restart doesn't lose the
   * verdict between bot-poll and user-click. Cleared by the desktop after the
   * uninstall actually fires (or after the user chooses to cancel).
   */
  lastUninstallDecision: { reqId: string; verdict: 'approved' | 'denied'; decidedAt: string } | null;
  /** ISO timestamp when the friend issued /revoke. Null when phase != 'revoked'. */
  friendRevokedAt: string | null;
}

/** 72 hours in milliseconds. Override to a small value in tests. */
export const EMERGENCY_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/** Build a fresh DelegationState in the `enrolled` phase. */
export function makeDelegation(pairingId: string): DelegationState {
  return {
    pairingId,
    friendName: null,
    friendChatId: null,
    pairedAt: null,
    lastConsumedSeq: 0,
    phase: 'enrolled',
    pendingUninstallReqId: null,
    emergencyUninstallStartedAt: null,
    lastUninstallDecision: null,
    friendRevokedAt: null,
  };
}

/** True iff this schedule is being held under a friend's keys (not a self-set lock). */
export function isDelegated(s: Schedule): boolean {
  return s.delegation != null;
}

/**
 * True iff the user is inside the 72h emergency-uninstall cooldown window.
 * Phase-2 helper; returns false in alpha because no code path sets emergencyUninstallStartedAt.
 */
export function isInEmergencyCooldown(s: Schedule, nowMs: number = Date.now()): boolean {
  const startedAt = s.delegation?.emergencyUninstallStartedAt;
  if (!startedAt) return false;
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return false;
  return nowMs - startMs < EMERGENCY_COOLDOWN_MS;
}

/**
 * Milliseconds remaining in the emergency cooldown.
 * Returns 0 when no cooldown is active or when it has already elapsed.
 */
export function emergencyCooldownRemainingMs(s: Schedule, nowMs: number = Date.now()): number {
  const startedAt = s.delegation?.emergencyUninstallStartedAt;
  if (!startedAt) return 0;
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return 0;
  const remaining = startMs + EMERGENCY_COOLDOWN_MS - nowMs;
  return Math.max(0, remaining);
}

/**
 * True iff the user is allowed to *start* an emergency uninstall right now.
 * Requires a delegated lock with no cooldown already in flight.
 */
export function canStartEmergencyUninstall(s: Schedule): boolean {
  if (!isDelegated(s)) return false;
  return s.delegation?.emergencyUninstallStartedAt == null;
}

/**
 * Result type for `uninstallGate` — the single source of truth for "may the
 * user uninstall NightOwl right now?" used by daemon:uninstall and the UI.
 *
 * `reason` is the user-facing string — keep it actionable.
 */
export type UninstallGate =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

/**
 * Decide whether daemon:uninstall is allowed given current state.
 *
 * Self-set lock (no delegation): allowed if the user supplies the right password.
 *   The caller (api.ts) checks the password; this function returns allowed=true
 *   for the non-delegated case so the password check is the only gate.
 *
 * Delegated, lock not active yet (enrolled/paired/awaiting_password): allowed —
 *   nothing is locking anything yet, and the user can cancel pairing then uninstall.
 *
 * Delegated, lock active: allowed only if the friend approved (latest decision is
 *   'approved') OR the 72h emergency cooldown has elapsed.
 *
 * Delegated, friend revoked: same as active — friend won't approve so the only
 *   path is the emergency cooldown elapsing.
 *
 * `nowMs` injectable for tests.
 */
export function uninstallGate(s: Schedule, nowMs: number = Date.now()): UninstallGate {
  if (!isDelegated(s) || !s.delegation) {
    return { allowed: true, reason: 'self-set lock — password check applies' };
  }
  // Pre-active phases: nothing is enforcing yet.
  if (s.delegation.phase !== 'active' && s.delegation.phase !== 'revoked') {
    return { allowed: true, reason: 'pairing in flight — cancel pairing instead of uninstalling' };
  }
  const last = s.delegation.lastUninstallDecision;
  if (last && last.verdict === 'approved') {
    return { allowed: true, reason: `friend approved at ${last.decidedAt}` };
  }
  if (s.delegation.emergencyUninstallStartedAt) {
    const remaining = emergencyCooldownRemainingMs(s, nowMs);
    if (remaining <= 0) {
      return { allowed: true, reason: '72h emergency cooldown elapsed' };
    }
    const hoursLeft = Math.ceil(remaining / 1000 / 60 / 60);
    return { allowed: false, reason: `Emergency cooldown in progress — ${hoursLeft}h remaining. NightOwl will allow uninstall when it elapses.` };
  }
  if (last && last.verdict === 'denied') {
    return { allowed: false, reason: `Friend denied your last request. Send a new request, or start the 72h emergency cooldown.` };
  }
  if (s.delegation.pendingUninstallReqId) {
    return { allowed: false, reason: `Waiting on your friend to /approve or /deny in Telegram. You can also start the 72h emergency cooldown to escape without them.` };
  }
  if (s.delegation.phase === 'revoked') {
    return { allowed: false, reason: `Your friend stepped away from this lock. Start the 72h emergency cooldown to uninstall.` };
  }
  return { allowed: false, reason: `Friend Lock is active. Ask your friend to approve uninstall, or start the 72h emergency cooldown.` };
}

/**
 * Decide whether a Friend-Focus early-release is allowed right now.
 *
 * Solo focus (no friendGated, or friendGated=false): not gated by this function
 *   — solo Focus is uncancellable by design (v1 contract). The renderer should
 *   not even show the "Need out early?" card for solo sessions.
 *
 * Friend-gated focus, no friend pairing exists: should never happen in normal
 *   flow (the renderer prevents starting friend-gated focus without a pairing),
 *   but if it does, deny — there's nobody to ask.
 *
 * Friend-gated focus, decision approved: allowed.
 * Friend-gated focus, decision denied: not allowed; user can re-request.
 * Friend-gated focus, request pending: not allowed; waiting on friend.
 * Friend-gated focus, no request yet: not allowed; need to ask.
 *
 * Note there is NO 72h emergency cooldown for focus — sessions are short
 * (max 8h per the existing Focus validation), and a "wait it out" worst case
 * is the natural safety net. The cooldown is reserved for the schedule lock.
 *
 * `nowMs` is unused today — accepted for symmetry with `uninstallGate` so
 * future time-based gates (e.g. "approval expires after N minutes") drop in
 * without changing the call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function focusReleaseGate(s: Schedule, focus: FocusSession, _nowMs: number = Date.now()): UninstallGate {
  if (!focus.friendGated) {
    return { allowed: false, reason: 'Solo focus session — uncancellable by design.' };
  }
  if (!isDelegated(s)) {
    return { allowed: false, reason: 'No friend is paired. Re-pair before starting a friend-gated focus session.' };
  }
  const last = focus.lastReleaseDecision;
  if (last && last.verdict === 'approved') {
    return { allowed: true, reason: `friend approved at ${last.decidedAt}` };
  }
  if (last && last.verdict === 'denied') {
    return { allowed: false, reason: `Friend denied your last request. Send a new request or wait the timer out.` };
  }
  if (focus.pendingReleaseReqId) {
    return { allowed: false, reason: `Waiting on your friend to /approve or /deny in Telegram.` };
  }
  return { allowed: false, reason: `Ask your friend to release this focus session early.` };
}
