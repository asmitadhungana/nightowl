import {
  makeAccount,
  findDevice,
  attachDevice,
  detachDevice,
  recordHeartbeat,
  curfewCompliance,
  nextStreak,
  buildCurfewReport,
  MAX_DEVICES_PER_ACCOUNT,
  HEARTBEAT_STALE_MS,
} from '../account.js';
import type { Account } from '../account.js';

const PK = (n: number): string => n.toString(16).padStart(64, '0');
const NOW_ISO = '2026-05-26T22:30:00.000Z';
const NOW = Date.parse(NOW_ISO);

function acct(): Account {
  return makeAccount('acc-1', { devicePubkeyHex: PK(1), label: 'Pixel 8' }, NOW_ISO);
}

describe('makeAccount', () => {
  it('creates a single-device account with sane defaults', () => {
    const a = acct();
    expect(a.accountId).toBe('acc-1');
    expect(a.createdAt).toBe(NOW_ISO);
    expect(a.devices).toHaveLength(1);
    expect(a.devices[0]).toEqual({
      devicePubkeyHex: PK(1),
      label: 'Pixel 8',
      attachedAt: NOW_ISO,
      lastHeartbeatAt: null,
      lastEnforcing: false,
    });
  });
});

describe('findDevice', () => {
  it('finds an attached device and returns undefined otherwise', () => {
    const a = acct();
    expect(findDevice(a, PK(1))?.label).toBe('Pixel 8');
    expect(findDevice(a, PK(2))).toBeUndefined();
  });
});

describe('attachDevice', () => {
  it('attaches a new device without mutating the input', () => {
    const a = acct();
    const r = attachDevice(a, { devicePubkeyHex: PK(2), label: 'MacBook' }, NOW_ISO);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.devices).toHaveLength(2);
      expect(findDevice(r.account, PK(2))?.label).toBe('MacBook');
    }
    expect(a.devices).toHaveLength(1); // input untouched
  });

  it('rejects a duplicate device', () => {
    const r = attachDevice(acct(), { devicePubkeyHex: PK(1), label: 'dupe' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already attached/);
  });

  it('rejects a malformed pubkey', () => {
    const r = attachDevice(acct(), { devicePubkeyHex: 'NOTHEX', label: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/64 lowercase hex/);
  });

  it('rejects attaching past the device cap', () => {
    let a = acct();
    for (let i = 2; i <= MAX_DEVICES_PER_ACCOUNT; i++) {
      const r = attachDevice(a, { devicePubkeyHex: PK(i), label: `d${i}` });
      expect(r.ok).toBe(true);
      if (r.ok) a = r.account;
    }
    expect(a.devices).toHaveLength(MAX_DEVICES_PER_ACCOUNT);
    const over = attachDevice(a, { devicePubkeyHex: PK(99), label: 'too many' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/device limit/);
  });
});

describe('detachDevice', () => {
  it('detaches a known device when more than one remains', () => {
    const two = attachDevice(acct(), { devicePubkeyHex: PK(2), label: 'MacBook' });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    const r = detachDevice(two.account, PK(1));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.devices).toHaveLength(1);
      expect(findDevice(r.account, PK(1))).toBeUndefined();
    }
  });

  it('refuses to detach the last device (no orphan accounts)', () => {
    const r = detachDevice(acct(), PK(1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/last device/);
  });

  it('refuses to detach an unknown device', () => {
    const r = detachDevice(acct(), PK(7));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not attached/);
  });
});

describe('recordHeartbeat', () => {
  it('updates only the reporting device', () => {
    const two = attachDevice(acct(), { devicePubkeyHex: PK(2), label: 'MacBook' });
    if (!two.ok) throw new Error('setup');
    const r = recordHeartbeat(two.account, PK(2), true, NOW_ISO);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(findDevice(r.account, PK(2))?.lastHeartbeatAt).toBe(NOW_ISO);
      expect(findDevice(r.account, PK(2))?.lastEnforcing).toBe(true);
      expect(findDevice(r.account, PK(1))?.lastHeartbeatAt).toBeNull(); // untouched
    }
  });

  it('rejects a heartbeat from an unattached device', () => {
    const r = recordHeartbeat(acct(), PK(5), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not attached/);
  });
});

describe('curfewCompliance', () => {
  it('flags never_reported devices as a coverage gap', () => {
    const c = curfewCompliance(acct(), NOW);
    expect(c.status).toBe('coverage_gap');
    expect(c.devices[0].reason).toBe('never_reported');
    expect(c.gapDevices).toEqual([PK(1)]);
  });

  it('is kept when the only device is fresh + enforcing', () => {
    const r = recordHeartbeat(acct(), PK(1), true, NOW_ISO);
    if (!r.ok) throw new Error('setup');
    const c = curfewCompliance(r.account, NOW);
    expect(c.status).toBe('kept');
    expect(c.gapDevices).toEqual([]);
  });

  it('treats a fresh-but-not-enforcing device as a gap', () => {
    const r = recordHeartbeat(acct(), PK(1), false, NOW_ISO);
    if (!r.ok) throw new Error('setup');
    const c = curfewCompliance(r.account, NOW);
    expect(c.status).toBe('coverage_gap');
    expect(c.devices[0].reason).toBe('not_enforcing');
  });

  it('staleness boundary: just-under is covered, exactly-stale is a gap', () => {
    const justUnder = recordHeartbeat(acct(), PK(1), true, new Date(NOW - HEARTBEAT_STALE_MS + 1).toISOString());
    if (!justUnder.ok) throw new Error('setup');
    expect(curfewCompliance(justUnder.account, NOW).status).toBe('kept');

    const exactly = recordHeartbeat(acct(), PK(1), true, new Date(NOW - HEARTBEAT_STALE_MS).toISOString());
    if (!exactly.ok) throw new Error('setup');
    const c = curfewCompliance(exactly.account, NOW);
    expect(c.status).toBe('coverage_gap');
    expect(c.devices[0].reason).toBe('stale');
  });

  it('one enforcing + one stale device = gap naming the silent device (second-screen bypass)', () => {
    const two = attachDevice(acct(), { devicePubkeyHex: PK(2), label: 'MacBook' });
    if (!two.ok) throw new Error('setup');
    let a = two.account;
    const beat1 = recordHeartbeat(a, PK(1), true, NOW_ISO); // phone enforcing
    if (!beat1.ok) throw new Error('setup');
    a = beat1.account;
    // laptop never beats → silent → gap
    const c = curfewCompliance(a, NOW);
    expect(c.status).toBe('coverage_gap');
    expect(c.gapDevices).toEqual([PK(2)]);
  });

  it('malformed timestamp counts as stale, not covered', () => {
    const a = acct();
    a.devices[0].lastHeartbeatAt = 'not-a-date';
    a.devices[0].lastEnforcing = true;
    const c = curfewCompliance(a, NOW);
    expect(c.status).toBe('coverage_gap');
    expect(c.devices[0].reason).toBe('stale');
  });
});

describe('nextStreak', () => {
  it('increments on kept and resets on a gap', () => {
    expect(nextStreak(4, 'kept')).toBe(5);
    expect(nextStreak(4, 'coverage_gap')).toBe(0);
    expect(nextStreak(0, 'kept')).toBe(1);
  });
});

describe('buildCurfewReport', () => {
  it('reports kept + extends streak when all devices cover', () => {
    const r = recordHeartbeat(acct(), PK(1), true, NOW_ISO);
    if (!r.ok) throw new Error('setup');
    const report = buildCurfewReport(r.account, 3, NOW);
    expect(report.status).toBe('kept');
    expect(report.streak).toBe(4);
    expect(report.deviceCount).toBe(1);
    expect(report.gapCount).toBe(0);
    expect(report.accountId).toBe('acc-1');
  });

  it('reports a gap + resets streak when a device is silent', () => {
    const report = buildCurfewReport(acct(), 9, NOW); // never reported
    expect(report.status).toBe('coverage_gap');
    expect(report.streak).toBe(0);
    expect(report.gapCount).toBe(1);
  });
});
