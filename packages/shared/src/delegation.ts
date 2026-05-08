/**
 * NightOwl Friend-Lock Delegation State (v2)
 *
 * Pure types and small predicates. State is persisted as a field on `Schedule`
 * (see types.ts → Schedule.delegation). This module owns the *shape* and
 * lifecycle predicates; the orchestration logic (polling, IPC, side effects)
 * lives in packages/desktop/src/main/friendlock.ts.
 */

import type { Schedule } from './types.js';

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
   * Phase-2 only: id of the in-flight uninstall request awaiting friend approval.
   * Null in alpha and whenever no request is pending.
   */
  pendingUninstallReqId: string | null;
  /**
   * Phase-2 only: ISO timestamp when the user started the 72h emergency
   * uninstall cooldown. Null if cooldown is not active.
   */
  emergencyUninstallStartedAt: string | null;
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
