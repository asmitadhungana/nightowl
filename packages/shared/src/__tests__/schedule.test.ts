import {
  isLocked,
  getDayProgress,
  activateSchedule,
  deactivateSchedule,
  createFocusSession,
  isFocusActive,
  getFocusRemaining,
  validateSchedule,
  copyDayToAll,
  PRESETS,
} from '../schedule.js';
import { timeToMinutes, minutesToTime, isTimeInCurfew } from '../time.js';
import type { Schedule, FocusSession } from '../types.js';
import { DEFAULT_SCHEDULE } from '../types.js';

describe('timeToMinutes', () => {
  it('converts midnight correctly', () => {
    expect(timeToMinutes('00:00')).toBe(0);
  });

  it('converts noon correctly', () => {
    expect(timeToMinutes('12:00')).toBe(720);
  });

  it('converts end of day correctly', () => {
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('converts arbitrary time correctly', () => {
    expect(timeToMinutes('22:30')).toBe(1350);
  });
});

describe('minutesToTime', () => {
  it('converts 0 to 00:00', () => {
    expect(minutesToTime(0)).toBe('00:00');
  });

  it('converts 720 to 12:00', () => {
    expect(minutesToTime(720)).toBe('12:00');
  });

  it('converts 1350 to 22:30', () => {
    expect(minutesToTime(1350)).toBe('22:30');
  });
});

describe('isTimeInCurfew', () => {
  describe('overnight curfew (22:00-06:00)', () => {
    const startMin = timeToMinutes('22:00'); // 1320
    const endMin = timeToMinutes('06:00');   // 360

    it('returns true at 23:00', () => {
      expect(isTimeInCurfew(timeToMinutes('23:00'), startMin, endMin)).toBe(true);
    });

    it('returns true at 03:00', () => {
      expect(isTimeInCurfew(timeToMinutes('03:00'), startMin, endMin)).toBe(true);
    });

    it('returns true at exactly 22:00', () => {
      expect(isTimeInCurfew(timeToMinutes('22:00'), startMin, endMin)).toBe(true);
    });

    it('returns false at exactly 06:00 (curfew ends)', () => {
      expect(isTimeInCurfew(timeToMinutes('06:00'), startMin, endMin)).toBe(false);
    });

    it('returns false at 12:00', () => {
      expect(isTimeInCurfew(timeToMinutes('12:00'), startMin, endMin)).toBe(false);
    });

    it('returns false at 21:59', () => {
      expect(isTimeInCurfew(timeToMinutes('21:59'), startMin, endMin)).toBe(false);
    });
  });

  describe('same-day curfew (13:00-17:00)', () => {
    const startMin = timeToMinutes('13:00'); // 780
    const endMin = timeToMinutes('17:00');   // 1020

    it('returns true at 14:00', () => {
      expect(isTimeInCurfew(timeToMinutes('14:00'), startMin, endMin)).toBe(true);
    });

    it('returns true at exactly 13:00', () => {
      expect(isTimeInCurfew(timeToMinutes('13:00'), startMin, endMin)).toBe(true);
    });

    it('returns false at exactly 17:00 (curfew ends)', () => {
      expect(isTimeInCurfew(timeToMinutes('17:00'), startMin, endMin)).toBe(false);
    });

    it('returns false at 12:00', () => {
      expect(isTimeInCurfew(timeToMinutes('12:00'), startMin, endMin)).toBe(false);
    });

    it('returns false at 18:00', () => {
      expect(isTimeInCurfew(timeToMinutes('18:00'), startMin, endMin)).toBe(false);
    });
  });
});

describe('isLocked', () => {
  it('returns false when schedule is not active', () => {
    const schedule: Schedule = { ...DEFAULT_SCHEDULE, active: false };
    expect(isLocked(schedule)).toBe(false);
  });

  it('returns false when lockEndDate is null', () => {
    const schedule: Schedule = { ...DEFAULT_SCHEDULE, active: true, lockEndDate: null };
    expect(isLocked(schedule)).toBe(false);
  });

  it('returns false when lock has expired', () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const schedule: Schedule = { ...DEFAULT_SCHEDULE, active: true, lockEndDate: pastDate };
    expect(isLocked(schedule)).toBe(false);
  });

  it('returns true when lock is still active', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const schedule: Schedule = { ...DEFAULT_SCHEDULE, active: true, lockEndDate: futureDate };
    expect(isLocked(schedule)).toBe(true);
  });
});

describe('activateSchedule', () => {
  it('sets active to true', () => {
    const result = activateSchedule(DEFAULT_SCHEDULE, 7);
    expect(result.active).toBe(true);
  });

  it('sets lockPeriodDays', () => {
    const result = activateSchedule(DEFAULT_SCHEDULE, 14);
    expect(result.lockPeriodDays).toBe(14);
  });

  it('sets lockStartDate to now', () => {
    const before = Date.now();
    const result = activateSchedule(DEFAULT_SCHEDULE, 7);
    const after = Date.now();

    const startDate = new Date(result.lockStartDate!).getTime();
    expect(startDate).toBeGreaterThanOrEqual(before);
    expect(startDate).toBeLessThanOrEqual(after);
  });

  it('sets lockEndDate to correct future date', () => {
    const result = activateSchedule(DEFAULT_SCHEDULE, 7);
    const startDate = new Date(result.lockStartDate!);
    const endDate = new Date(result.lockEndDate!);

    const diffDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });
});

describe('deactivateSchedule', () => {
  it('sets active to false', () => {
    const active = activateSchedule(DEFAULT_SCHEDULE, 7);
    const result = deactivateSchedule(active);
    expect(result.active).toBe(false);
  });

  it('clears lockPeriodDays', () => {
    const active = activateSchedule(DEFAULT_SCHEDULE, 7);
    const result = deactivateSchedule(active);
    expect(result.lockPeriodDays).toBeNull();
  });

  it('clears lockStartDate', () => {
    const active = activateSchedule(DEFAULT_SCHEDULE, 7);
    const result = deactivateSchedule(active);
    expect(result.lockStartDate).toBeNull();
  });

  it('clears lockEndDate', () => {
    const active = activateSchedule(DEFAULT_SCHEDULE, 7);
    const result = deactivateSchedule(active);
    expect(result.lockEndDate).toBeNull();
  });
});

describe('getDayProgress', () => {
  it('returns null when schedule is not active', () => {
    expect(getDayProgress(DEFAULT_SCHEDULE)).toBeNull();
  });

  it('returns correct progress for day 1', () => {
    const now = new Date();
    const schedule: Schedule = {
      ...DEFAULT_SCHEDULE,
      active: true,
      lockPeriodDays: 7,
      lockStartDate: now.toISOString(),
      lockEndDate: new Date(now.getTime() + 7 * 86400000).toISOString(),
    };

    const progress = getDayProgress(schedule);
    expect(progress).not.toBeNull();
    expect(progress!.dayNum).toBe(1);
    expect(progress!.totalDays).toBe(7);
    expect(progress!.percent).toBeLessThanOrEqual(100);
  });

  it('returns correct progress mid-period', () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 3 * 86400000); // 3 days ago
    const schedule: Schedule = {
      ...DEFAULT_SCHEDULE,
      active: true,
      lockPeriodDays: 7,
      lockStartDate: startDate.toISOString(),
      lockEndDate: new Date(startDate.getTime() + 7 * 86400000).toISOString(),
    };

    const progress = getDayProgress(schedule);
    expect(progress).not.toBeNull();
    expect(progress!.dayNum).toBe(4); // Day 4 (0-3 full days passed + current)
    expect(progress!.totalDays).toBe(7);
  });
});

describe('Focus session', () => {
  describe('createFocusSession', () => {
    it('creates active session', () => {
      const focus = createFocusSession(25);
      expect(focus.active).toBe(true);
    });

    it('sets correct duration', () => {
      const focus = createFocusSession(25);
      expect(focus.minutes).toBe(25);
    });

    it('sets correct end time', () => {
      const focus = createFocusSession(25);
      const startTime = new Date(focus.startTime);
      const endTime = new Date(focus.endTime);
      const diffMins = (endTime.getTime() - startTime.getTime()) / 60000;
      expect(diffMins).toBe(25);
    });
  });

  describe('isFocusActive', () => {
    it('returns false for null', () => {
      expect(isFocusActive(null)).toBe(false);
    });

    it('returns false for inactive session', () => {
      const focus: FocusSession = {
        active: false,
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString(),
        minutes: 1,
      };
      expect(isFocusActive(focus)).toBe(false);
    });

    it('returns false for expired session', () => {
      const focus: FocusSession = {
        active: true,
        startTime: new Date(Date.now() - 120000).toISOString(),
        endTime: new Date(Date.now() - 60000).toISOString(),
        minutes: 1,
      };
      expect(isFocusActive(focus)).toBe(false);
    });

    it('returns true for active session', () => {
      const focus = createFocusSession(25);
      expect(isFocusActive(focus)).toBe(true);
    });
  });

  describe('getFocusRemaining', () => {
    it('returns 0 for null', () => {
      expect(getFocusRemaining(null)).toBe(0);
    });

    it('returns 0 for expired session', () => {
      const focus: FocusSession = {
        active: true,
        startTime: new Date(Date.now() - 120000).toISOString(),
        endTime: new Date(Date.now() - 60000).toISOString(),
        minutes: 1,
      };
      expect(getFocusRemaining(focus)).toBe(0);
    });

    it('returns positive value for active session', () => {
      const focus = createFocusSession(25);
      const remaining = getFocusRemaining(focus);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(25 * 60);
    });
  });
});

describe('validateSchedule', () => {
  it('accepts valid schedule', () => {
    const errors = validateSchedule(DEFAULT_SCHEDULE);
    expect(errors).toHaveLength(0);
  });

  it('rejects invalid time format', () => {
    const schedule = {
      ...DEFAULT_SCHEDULE,
      days: {
        ...DEFAULT_SCHEDULE.days,
        monday: { curfewStart: '25:00', curfewEnd: '06:00' },
      },
    };
    const errors = validateSchedule(schedule);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Invalid curfew start time');
  });

  it('rejects lock period below 1', () => {
    const schedule = { ...DEFAULT_SCHEDULE, lockPeriodDays: 0 };
    const errors = validateSchedule(schedule);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Lock period');
  });

  it('rejects lock period above 365', () => {
    const schedule = { ...DEFAULT_SCHEDULE, lockPeriodDays: 400 };
    const errors = validateSchedule(schedule);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Lock period');
  });

  it('rejects invalid timezone', () => {
    const schedule = { ...DEFAULT_SCHEDULE, timezone: 'Invalid/Timezone' };
    const errors = validateSchedule(schedule);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Invalid timezone');
  });
});

describe('copyDayToAll', () => {
  it('copies source day to all days', () => {
    const schedule: Schedule = {
      ...DEFAULT_SCHEDULE,
      days: {
        ...DEFAULT_SCHEDULE.days,
        monday: { curfewStart: '23:00', curfewEnd: '07:00' },
      },
    };

    const result = copyDayToAll(schedule, 'monday');

    expect(result.days.tuesday).toEqual({ curfewStart: '23:00', curfewEnd: '07:00' });
    expect(result.days.wednesday).toEqual({ curfewStart: '23:00', curfewEnd: '07:00' });
    expect(result.days.sunday).toEqual({ curfewStart: '23:00', curfewEnd: '07:00' });
  });
});

describe('PRESETS', () => {
  it('has Night Owl preset', () => {
    const nightOwl = PRESETS.find(p => p.name === 'Night Owl');
    expect(nightOwl).toBeDefined();

    const days = nightOwl!.getDays();
    expect(days.monday.curfewStart).toBe('22:00');
    expect(days.monday.curfewEnd).toBe('06:00');
  });

  it('has Early Bird preset', () => {
    const earlyBird = PRESETS.find(p => p.name === 'Early Bird');
    expect(earlyBird).toBeDefined();

    const days = earlyBird!.getDays();
    expect(days.monday.curfewStart).toBe('21:00');
    expect(days.monday.curfewEnd).toBe('05:00');
  });

  it('has Weekend Flex preset with different weekend times', () => {
    const weekendFlex = PRESETS.find(p => p.name === 'Weekend Flex');
    expect(weekendFlex).toBeDefined();

    const days = weekendFlex!.getDays();
    expect(days.monday.curfewStart).toBe('22:00');
    expect(days.saturday.curfewStart).toBe('23:00');
    expect(days.sunday.curfewStart).toBe('23:00');
  });
});
