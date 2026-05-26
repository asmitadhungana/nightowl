import {
  makeCircle,
  findMember,
  isMember,
  memberCount,
  addMember,
  removeMember,
  isEmpty,
  MAX_CIRCLE_MEMBERS,
  MAX_CIRCLE_NAME_LEN,
} from '../circle.js';
import type { Circle } from '../circle.js';

const NOW = '2026-05-26T22:00:00.000Z';

function circle(): Circle {
  return makeCircle('c-1', 'Sleep Squad', { chatId: '100', name: 'Asmee' }, NOW);
}

describe('makeCircle', () => {
  it('creates a circle with the founder as sole creator', () => {
    const c = circle();
    expect(c.circleId).toBe('c-1');
    expect(c.name).toBe('Sleep Squad');
    expect(c.members).toHaveLength(1);
    expect(c.members[0]).toEqual({ chatId: '100', name: 'Asmee', role: 'creator', joinedAt: NOW });
  });

  it('trims + truncates an over-long name', () => {
    const long = 'x'.repeat(MAX_CIRCLE_NAME_LEN + 20);
    const c = makeCircle('c-2', `  ${long}  `, { chatId: '1', name: 'A' });
    expect(c.name.length).toBe(MAX_CIRCLE_NAME_LEN);
  });
});

describe('findMember / isMember / memberCount', () => {
  it('finds members and counts them', () => {
    const c = circle();
    expect(isMember(c, '100')).toBe(true);
    expect(findMember(c, '100')?.name).toBe('Asmee');
    expect(isMember(c, '999')).toBe(false);
    expect(memberCount(c)).toBe(1);
  });
});

describe('addMember', () => {
  it('adds a new member with role=member, without mutating input', () => {
    const c = circle();
    const r = addMember(c, { chatId: '200', name: 'Sam' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(memberCount(r.circle)).toBe(2);
      expect(findMember(r.circle, '200')?.role).toBe('member');
    }
    expect(memberCount(c)).toBe(1); // input untouched
  });

  it('is a no-op success when re-adding an existing member', () => {
    const c = circle();
    const r = addMember(c, { chatId: '100', name: 'Asmee again' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(memberCount(r.circle)).toBe(1);
  });

  it('rejects an empty chatId', () => {
    const r = addMember(circle(), { chatId: '', name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/chatId required/);
  });

  it('rejects adding past the member cap', () => {
    let c = circle();
    for (let i = 2; i <= MAX_CIRCLE_MEMBERS; i++) {
      const r = addMember(c, { chatId: String(i), name: `m${i}` });
      expect(r.ok).toBe(true);
      if (r.ok) c = r.circle;
    }
    expect(memberCount(c)).toBe(MAX_CIRCLE_MEMBERS);
    const over = addMember(c, { chatId: '9999', name: 'too many' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/full/);
  });
});

describe('removeMember', () => {
  it('removes a known non-creator member', () => {
    const two = addMember(circle(), { chatId: '200', name: 'Sam' });
    if (!two.ok) throw new Error('setup');
    const r = removeMember(two.circle, '200');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isMember(r.circle, '200')).toBe(false);
      expect(memberCount(r.circle)).toBe(1);
    }
  });

  it('rejects removing an unknown member', () => {
    const r = removeMember(circle(), '404');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a member/);
  });

  it('promotes the earliest remaining member to creator when the creator leaves', () => {
    let c = circle(); // creator = 100
    const a = addMember(c, { chatId: '200', name: 'Sam' }, '2026-05-26T22:05:00.000Z');
    if (!a.ok) throw new Error('setup');
    const b = addMember(a.circle, { chatId: '300', name: 'Kit' }, '2026-05-26T22:10:00.000Z');
    if (!b.ok) throw new Error('setup');
    c = b.circle;
    const r = removeMember(c, '100'); // creator leaves
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(findMember(r.circle, '100')).toBeUndefined();
      // earliest remaining (200, joined before 300) becomes creator
      expect(findMember(r.circle, '200')?.role).toBe('creator');
      expect(findMember(r.circle, '300')?.role).toBe('member');
      expect(r.circle.members.filter((m) => m.role === 'creator')).toHaveLength(1);
    }
  });

  it('yields an empty circle when the last member leaves', () => {
    const r = removeMember(circle(), '100');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(memberCount(r.circle)).toBe(0);
      expect(isEmpty(r.circle)).toBe(true);
    }
  });
});
