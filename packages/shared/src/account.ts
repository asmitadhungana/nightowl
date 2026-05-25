/**
 * NightOwl Accounts + multi-device enforcement — Circles Phase 1.
 *
 * Mission invariant: "schedule lock enforcement no matter what" must hold across
 * ALL of a person's devices, not just one. Locking only the phone is theater if
 * the laptop stays open at 2am. An `Account` groups N device public keys under
 * one schedule + one lock, and curfew compliance is judged across EVERY
 * registered device — so a second screen cannot defeat the lock.
 *
 * This module is pure types + predicates, no I/O. The bot persists `Account`
 * records in KV; clients mirror the shape. Per the Circles design doc:
 *   - R3: accountId is bot-assigned, stable; devices attach via a signed join code.
 *   - R4: device *removal* is a release-class action (caller must gate it behind
 *     threshold approval — this module exposes the transition but never the policy).
 *   - R5: "kept curfew" = every registered device heartbeats `enforced`; any
 *     non-heartbeating-or-not-enforcing registered device is a COVERAGE GAP,
 *     full stop. A powered-off device is wire-indistinguishable from a
 *     force-stopped one, so silence never counts as "kept."
 *
 * Any change here must stay byte-compatible with the Kotlin mirror
 * (packages/android/.../Account.kt). Wire format is shared; code is not.
 */

/** One device enrolled under an account. */
export interface AccountDevice {
  /** Raw 32-byte Ed25519 public key, hex. Stable per install; the device's identity. */
  devicePubkeyHex: string;
  /** Human label for UI ("Pixel 8", "MacBook Air"). Non-unique, cosmetic. */
  label: string;
  /** ISO timestamp the device was attached to the account. */
  attachedAt: string;
  /** ISO timestamp of the most recent enforcement heartbeat. Null until the first beat. */
  lastHeartbeatAt: string | null;
  /** Whether the most recent heartbeat reported NightOwl actively enforcing the curfew. */
  lastEnforcing: boolean;
}

/** One person = one schedule + N devices that all enforce it. */
export interface Account {
  /** Bot-assigned UUID; primary key, stable for the person's lifetime. */
  accountId: string;
  /** ISO timestamp of account creation (first device enroll). */
  createdAt: string;
  /** All devices sharing this account's schedule + lock. Invariant: length >= 1. */
  devices: AccountDevice[];
}

/**
 * Max devices per account. Generous for real life (phone, laptop, tablet, work
 * laptop, …) but bounded — caps KV growth and removes any incentive to register
 * phantom devices.
 */
export const MAX_DEVICES_PER_ACCOUNT = 10;

/**
 * A heartbeat is "fresh" if seen within this window. Sized to tolerate Android
 * Doze (which can stretch a 60s tick to 5–15 min) without false coverage gaps,
 * while still catching a device that has genuinely stopped enforcing.
 */
export const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/** Result of attaching/detaching — a discriminated union so callers handle failure. */
export type AccountMutation =
  | { ok: true; account: Account }
  | { ok: false; reason: string };

/** Build a fresh single-device account. The first device is the founding device. */
export function makeAccount(
  accountId: string,
  first: { devicePubkeyHex: string; label: string },
  nowIso: string = new Date().toISOString(),
): Account {
  return {
    accountId,
    createdAt: nowIso,
    devices: [
      {
        devicePubkeyHex: first.devicePubkeyHex,
        label: first.label,
        attachedAt: nowIso,
        lastHeartbeatAt: null,
        lastEnforcing: false,
      },
    ],
  };
}

/** Find a device by pubkey, or undefined. */
export function findDevice(account: Account, devicePubkeyHex: string): AccountDevice | undefined {
  return account.devices.find((d) => d.devicePubkeyHex === devicePubkeyHex);
}

/**
 * Attach a new device to an account. Additive — never mutates the input.
 * Rejects duplicates and over-cap. The CALLER is responsible for having verified
 * the device-join code was confirmed by an existing device (design R3); this
 * function is the pure state transition only.
 */
export function attachDevice(
  account: Account,
  device: { devicePubkeyHex: string; label: string },
  nowIso: string = new Date().toISOString(),
): AccountMutation {
  if (!/^[0-9a-f]{64}$/.test(device.devicePubkeyHex)) {
    return { ok: false, reason: 'devicePubkeyHex must be 64 lowercase hex chars' };
  }
  if (findDevice(account, device.devicePubkeyHex)) {
    return { ok: false, reason: 'device already attached to this account' };
  }
  if (account.devices.length >= MAX_DEVICES_PER_ACCOUNT) {
    return { ok: false, reason: `account already at the ${MAX_DEVICES_PER_ACCOUNT}-device limit` };
  }
  const next: Account = {
    ...account,
    devices: [
      ...account.devices,
      {
        devicePubkeyHex: device.devicePubkeyHex,
        label: device.label,
        attachedAt: nowIso,
        lastHeartbeatAt: null,
        lastEnforcing: false,
      },
    ],
  };
  return { ok: true, account: next };
}

/**
 * Detach a device. Pure transition — does NOT enforce that detach is authorized.
 * Per design R4, detaching is a release-class action that the caller MUST gate
 * behind the account's release threshold (otherwise a user just removes their own
 * enforcing device to bypass). Refuses to orphan the account (can't remove the
 * last device) and refuses unknown devices.
 */
export function detachDevice(account: Account, devicePubkeyHex: string): AccountMutation {
  if (!findDevice(account, devicePubkeyHex)) {
    return { ok: false, reason: 'device not attached to this account' };
  }
  if (account.devices.length <= 1) {
    return { ok: false, reason: 'cannot detach the last device — an account must keep at least one' };
  }
  return {
    ok: true,
    account: { ...account, devices: account.devices.filter((d) => d.devicePubkeyHex !== devicePubkeyHex) },
  };
}

/**
 * Record an enforcement heartbeat from a device. `enforcing` is the device's
 * own report of whether NightOwl is actively enforcing the curfew right now.
 * Pure — returns a new Account. Errors if the device isn't attached.
 */
export function recordHeartbeat(
  account: Account,
  devicePubkeyHex: string,
  enforcing: boolean,
  nowIso: string = new Date().toISOString(),
): AccountMutation {
  if (!findDevice(account, devicePubkeyHex)) {
    return { ok: false, reason: 'heartbeat from a device not attached to this account' };
  }
  return {
    ok: true,
    account: {
      ...account,
      devices: account.devices.map((d) =>
        d.devicePubkeyHex === devicePubkeyHex
          ? { ...d, lastHeartbeatAt: nowIso, lastEnforcing: enforcing }
          : d,
      ),
    },
  };
}

/** Why a given device is or isn't currently covering the curfew. */
export type CoverageReason = 'enforcing' | 'stale' | 'not_enforcing' | 'never_reported';

export interface DeviceCoverage {
  devicePubkeyHex: string;
  label: string;
  covered: boolean;
  reason: CoverageReason;
}

export type ComplianceStatus = 'kept' | 'coverage_gap';

export interface CurfewCompliance {
  /** 'kept' iff every registered device is covered; otherwise 'coverage_gap'. */
  status: ComplianceStatus;
  /** Per-device coverage detail, in account order. */
  devices: DeviceCoverage[];
  /** Pubkeys of devices that are NOT covering — the gap. Empty iff 'kept'. */
  gapDevices: string[];
}

/**
 * Judge curfew compliance across the whole account (design R5).
 *
 * A device is "covered" iff its most recent heartbeat is fresh (within
 * `staleMs`) AND reported `enforcing`. Anything else is a gap:
 *   - never_reported : no heartbeat ever
 *   - stale          : last heartbeat older than staleMs (silent / offline / killed)
 *   - not_enforcing  : fresh heartbeat but NightOwl reported it wasn't enforcing
 *
 * The account is 'kept' only when ALL devices are covered. This is what makes
 * "a second device cannot defeat curfew" true: disabling NightOwl on the laptop
 * shows as a coverage gap, never silently as compliant.
 */
export function curfewCompliance(
  account: Account,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS,
): CurfewCompliance {
  const devices: DeviceCoverage[] = account.devices.map((d) => {
    if (d.lastHeartbeatAt == null) {
      return { devicePubkeyHex: d.devicePubkeyHex, label: d.label, covered: false, reason: 'never_reported' };
    }
    const beatMs = Date.parse(d.lastHeartbeatAt);
    if (Number.isNaN(beatMs) || nowMs - beatMs >= staleMs) {
      return { devicePubkeyHex: d.devicePubkeyHex, label: d.label, covered: false, reason: 'stale' };
    }
    if (!d.lastEnforcing) {
      return { devicePubkeyHex: d.devicePubkeyHex, label: d.label, covered: false, reason: 'not_enforcing' };
    }
    return { devicePubkeyHex: d.devicePubkeyHex, label: d.label, covered: true, reason: 'enforcing' };
  });
  const gapDevices = devices.filter((d) => !d.covered).map((d) => d.devicePubkeyHex);
  return { status: gapDevices.length === 0 ? 'kept' : 'coverage_gap', devices, gapDevices };
}

/** Streak math for witnessing: kept extends the streak, any gap resets it to 0. */
export function nextStreak(prevStreak: number, status: ComplianceStatus): number {
  return status === 'kept' ? prevStreak + 1 : 0;
}

/**
 * Payload for a `curfew_report` witnessing message (design §witnessing). Minimal
 * by default — no raw activity, no app usage, no location. Just the compliance
 * verdict, the streak, and device counts. Fanned out only to witnesses who have
 * opted into this account's signals (mutual opt-in, R6).
 */
export interface CurfewReportPayload {
  accountId: string;
  /** ISO date the report covers (the curfew night). */
  dateIso: string;
  status: ComplianceStatus;
  /** Consecutive kept nights including this one (0 on a gap). */
  streak: number;
  /** Total registered devices. */
  deviceCount: number;
  /** How many were not covering (0 iff kept). */
  gapCount: number;
}

/** Build a witnessing report from current account state + the prior streak. */
export function buildCurfewReport(
  account: Account,
  prevStreak: number,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS,
): CurfewReportPayload {
  const compliance = curfewCompliance(account, nowMs, staleMs);
  const status = compliance.status;
  return {
    accountId: account.accountId,
    dateIso: new Date(nowMs).toISOString(),
    status,
    streak: nextStreak(prevStreak, status),
    deviceCount: account.devices.length,
    gapCount: compliance.gapDevices.length,
  };
}
