import {
  makeDelegation,
  isDelegated,
  isInEmergencyCooldown,
  emergencyCooldownRemainingMs,
  canStartEmergencyUninstall,
  EMERGENCY_COOLDOWN_MS,
} from '../delegation.js';
import type { DelegationState } from '../delegation.js';
import type { Schedule } from '../types.js';
import { DEFAULT_SCHEDULE } from '../types.js';

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
