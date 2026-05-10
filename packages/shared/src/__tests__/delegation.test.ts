import {
  makeDelegation,
  isDelegated,
  isInEmergencyCooldown,
  emergencyCooldownRemainingMs,
  canStartEmergencyUninstall,
  uninstallGate,
  focusReleaseGate,
  EMERGENCY_COOLDOWN_MS,
} from '../delegation.js';
import type { DelegationState } from '../delegation.js';
import type { Schedule, FocusSession } from '../types.js';
import { DEFAULT_SCHEDULE } from '../types.js';

function focus(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    active: true,
    startTime: '2026-05-10T12:00:00.000Z',
    endTime: '2026-05-10T12:30:00.000Z',
    minutes: 30,
    ...overrides,
  };
}

function scheduleWith(delegation: DelegationState | null | undefined): Schedule {
  return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days }, delegation };
}

describe('makeDelegation', () => {
  it('creates an enrolled DelegationState with sane defaults', () => {
    const d = makeDelegation('pair-uuid-abc');
    expect(d.pairingId).toBe('pair-uuid-abc');
    expect(d.phase).toBe('enrolled');
    expect(d.lastConsumedSeq).toBe(0);
    expect(d.friendName).toBeNull();
    expect(d.friendChatId).toBeNull();
    expect(d.pairedAt).toBeNull();
    expect(d.pendingUninstallReqId).toBeNull();
    expect(d.emergencyUninstallStartedAt).toBeNull();
  });
});

describe('isDelegated', () => {
  it('returns false when delegation is undefined (v1 schedule shape)', () => {
    const s: Schedule = { ...DEFAULT_SCHEDULE };
    expect(isDelegated(s)).toBe(false);
  });

  it('returns false when delegation is null', () => {
    expect(isDelegated(scheduleWith(null))).toBe(false);
  });

  it('returns true when delegation is set', () => {
    expect(isDelegated(scheduleWith(makeDelegation('p1')))).toBe(true);
  });
});

describe('isInEmergencyCooldown', () => {
  const now = new Date('2026-06-01T12:00:00Z').getTime();

  it('returns false when delegation is absent', () => {
    expect(isInEmergencyCooldown(scheduleWith(null), now)).toBe(false);
  });

  it('returns false when emergencyUninstallStartedAt is null', () => {
    const d = makeDelegation('p1');
    expect(isInEmergencyCooldown(scheduleWith(d), now)).toBe(false);
  });

  it('returns true 1ms before cooldown elapses', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date(now - EMERGENCY_COOLDOWN_MS + 1).toISOString() };
    expect(isInEmergencyCooldown(scheduleWith(d), now)).toBe(true);
  });

  it('returns false at exactly cooldown elapsed', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date(now - EMERGENCY_COOLDOWN_MS).toISOString() };
    expect(isInEmergencyCooldown(scheduleWith(d), now)).toBe(false);
  });

  it('returns false 1ms after cooldown elapses', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date(now - EMERGENCY_COOLDOWN_MS - 1).toISOString() };
    expect(isInEmergencyCooldown(scheduleWith(d), now)).toBe(false);
  });

  it('returns false on malformed timestamp', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: 'not-a-date' };
    expect(isInEmergencyCooldown(scheduleWith(d), now)).toBe(false);
  });
});

describe('emergencyCooldownRemainingMs', () => {
  const now = new Date('2026-06-01T12:00:00Z').getTime();

  it('returns 0 when cooldown not started', () => {
    expect(emergencyCooldownRemainingMs(scheduleWith(null), now)).toBe(0);
    expect(emergencyCooldownRemainingMs(scheduleWith(makeDelegation('p1')), now)).toBe(0);
  });

  it('returns roughly EMERGENCY_COOLDOWN_MS just after start', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date(now).toISOString() };
    expect(emergencyCooldownRemainingMs(scheduleWith(d), now)).toBe(EMERGENCY_COOLDOWN_MS);
  });

  it('returns 0 when cooldown has elapsed (does not go negative)', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date(now - EMERGENCY_COOLDOWN_MS - 99999).toISOString() };
    expect(emergencyCooldownRemainingMs(scheduleWith(d), now)).toBe(0);
  });
});

describe('canStartEmergencyUninstall', () => {
  it('returns false when not delegated', () => {
    expect(canStartEmergencyUninstall(scheduleWith(null))).toBe(false);
  });

  it('returns true when delegated and cooldown has not started', () => {
    expect(canStartEmergencyUninstall(scheduleWith(makeDelegation('p1')))).toBe(true);
  });

  it('returns false when delegated and cooldown is already in flight', () => {
    const d = { ...makeDelegation('p1'), emergencyUninstallStartedAt: new Date().toISOString() };
    expect(canStartEmergencyUninstall(scheduleWith(d))).toBe(false);
  });
});

describe('uninstallGate', () => {
  const now = Date.UTC(2026, 4, 10, 12, 0, 0);

  it('allows uninstall on a self-set lock (no delegation)', () => {
    const r = uninstallGate(scheduleWith(null), now);
    expect(r.allowed).toBe(true);
  });

  it('allows uninstall during pre-active pairing phases (cancel pairing instead)', () => {
    const phases = ['enrolled', 'paired', 'awaiting_password'] as const;
    for (const phase of phases) {
      const d = { ...makeDelegation('p1'), phase };
      const r = uninstallGate(scheduleWith(d), now);
      expect(r.allowed).toBe(true);
    }
  });

  it('blocks uninstall when active and friend has not approved', () => {
    const d = { ...makeDelegation('p1'), phase: 'active' as const };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(false);
  });

  it('blocks uninstall when a request is pending and no decision yet', () => {
    const d = {
      ...makeDelegation('p1'),
      phase: 'active' as const,
      pendingUninstallReqId: 'req-uuid-1',
    };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Waiting on your friend/);
  });

  it('allows uninstall after friend approves', () => {
    const d = {
      ...makeDelegation('p1'),
      phase: 'active' as const,
      lastUninstallDecision: { reqId: 'req-uuid-1', verdict: 'approved' as const, decidedAt: '2026-05-10T11:00:00.000Z' },
    };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/friend approved/);
  });

  it('blocks uninstall when friend denied (and no cooldown)', () => {
    const d = {
      ...makeDelegation('p1'),
      phase: 'active' as const,
      lastUninstallDecision: { reqId: 'req-uuid-1', verdict: 'denied' as const, decidedAt: '2026-05-10T11:00:00.000Z' },
    };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Friend denied/);
  });

  it('blocks uninstall when friend revoked (no cooldown started)', () => {
    const d = { ...makeDelegation('p1'), phase: 'revoked' as const, friendRevokedAt: '2026-05-10T11:00:00.000Z' };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/stepped away/);
  });

  it('blocks uninstall while emergency cooldown is in flight (with hours remaining)', () => {
    const startedAt = new Date(now - 1000 * 60 * 60).toISOString(); // 1h ago
    const d = { ...makeDelegation('p1'), phase: 'active' as const, emergencyUninstallStartedAt: startedAt };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cooldown in progress/i);
  });

  it('allows uninstall once emergency cooldown elapses', () => {
    const startedAt = new Date(now - EMERGENCY_COOLDOWN_MS - 1000).toISOString();
    const d = { ...makeDelegation('p1'), phase: 'active' as const, emergencyUninstallStartedAt: startedAt };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/72h emergency cooldown elapsed/);
  });

  it('approval beats a pending request id (decision wins)', () => {
    const d = {
      ...makeDelegation('p1'),
      phase: 'active' as const,
      pendingUninstallReqId: 'req-uuid-1',
      lastUninstallDecision: { reqId: 'req-uuid-1', verdict: 'approved' as const, decidedAt: '2026-05-10T11:00:00.000Z' },
    };
    const r = uninstallGate(scheduleWith(d), now);
    expect(r.allowed).toBe(true);
  });
});

describe('focusReleaseGate', () => {
  const now = Date.UTC(2026, 4, 10, 12, 0, 0);

  it('blocks release on a solo focus session (no friend gating)', () => {
    const r = focusReleaseGate(scheduleWith(makeDelegation('p1')), focus({ friendGated: false }), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/solo/i);
  });

  it('blocks release when friendGated but no delegation paired', () => {
    const r = focusReleaseGate(scheduleWith(null), focus({ friendGated: true }), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no friend is paired/i);
  });

  it('blocks release when friendGated, paired, no request yet', () => {
    const r = focusReleaseGate(scheduleWith(makeDelegation('p1')), focus({ friendGated: true }), now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Ask your friend/i);
  });

  it('blocks release when a request is pending and no decision yet', () => {
    const f = focus({ friendGated: true, pendingReleaseReqId: 'req-1' });
    const r = focusReleaseGate(scheduleWith(makeDelegation('p1')), f, now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Waiting/i);
  });

  it('allows release when friend approved', () => {
    const f = focus({
      friendGated: true,
      lastReleaseDecision: { reqId: 'req-1', verdict: 'approved', decidedAt: '2026-05-10T12:05:00.000Z' },
    });
    const r = focusReleaseGate(scheduleWith(makeDelegation('p1')), f, now);
    expect(r.allowed).toBe(true);
  });

  it('blocks release when friend denied', () => {
    const f = focus({
      friendGated: true,
      lastReleaseDecision: { reqId: 'req-1', verdict: 'denied', decidedAt: '2026-05-10T12:05:00.000Z' },
    });
    const r = focusReleaseGate(scheduleWith(makeDelegation('p1')), f, now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Friend denied/i);
  });

  it('does NOT honor schedule-lock decisions for focus release (separate verdicts)', () => {
    // Friend approved an UNINSTALL request; that should not green-light a focus release.
    const d = {
      ...makeDelegation('p1'),
      lastUninstallDecision: { reqId: 'req-uninstall', verdict: 'approved' as const, decidedAt: '2026-05-10T11:00:00.000Z' },
    };
    const r = focusReleaseGate(scheduleWith(d), focus({ friendGated: true }), now);
    expect(r.allowed).toBe(false);
  });
});
