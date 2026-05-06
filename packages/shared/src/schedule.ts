/**
 * NightOwl Schedule Logic
 * Core schedule parsing and curfew detection
 */

import type {
  Schedule,
  DaysSchedule,
  CurfewInfo,
  DayProgress,
  Status,
  DayName,
  FocusSession,
  SchedulePreset,
} from './types.js';
import { DEFAULT_SCHEDULE, DAYS } from './types.js';
import {
  timeToMinutes,
  getNowInTimezone,
  getDayName,
  isTimeInCurfew,
  minutesUntil,
  minutesUntilCurfewEnd,
} from './time.js';

/**
 * Check if schedule is currently locked (active and lock not expired)
 */
export function isLocked(schedule: Schedule): boolean {
  if (!schedule.active || !schedule.lockEndDate) {
    return false;
  }
  const now = new Date();
  const end = new Date(schedule.lockEndDate);
  return now < end;
}

/**
 * Check if curfew is currently active
 */
export function isCurfewActive(schedule: Schedule): boolean {
  if (!schedule.active) {
    return false;
  }

  const now = getNowInTimezone(schedule.timezone);
  const day = getDayName(now);
  const daySchedule = schedule.days[day];

  if (!daySchedule) {
    return false;
  }

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(daySchedule.curfewStart);
  const endMin = timeToMinutes(daySchedule.curfewEnd);

  return isTimeInCurfew(currentMin, startMin, endMin);
}

/**
 * Get information about next curfew transition
 */
export function getNextCurfewInfo(schedule: Schedule): CurfewInfo | null {
  if (!schedule.active) {
    return null;
  }

  const now = getNowInTimezone(schedule.timezone);
  const day = getDayName(now);
  const daySchedule = schedule.days[day];

  if (!daySchedule) {
    return null;
  }

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(daySchedule.curfewStart);
  const endMin = timeToMinutes(daySchedule.curfewEnd);

  const curfewActive = isTimeInCurfew(currentMin, startMin, endMin);

  if (curfewActive) {
    const minsUntilEnd = minutesUntilCurfewEnd(currentMin, startMin, endMin);
    return {
      curfewActive: true,
      minsUntilEnd,
      minsUntilStart: 0,
      curfewEnd: daySchedule.curfewEnd,
    };
  } else {
    const minsUntilStart = minutesUntil(currentMin, startMin);
    return {
      curfewActive: false,
      minsUntilStart,
      minsUntilEnd: 0,
      curfewStart: daySchedule.curfewStart,
    };
  }
}

/**
 * Calculate day progress during lock period
 */
export function getDayProgress(schedule: Schedule): DayProgress | null {
  if (!schedule.active || !schedule.lockStartDate || !schedule.lockEndDate || !schedule.lockPeriodDays) {
    return null;
  }

  const start = new Date(schedule.lockStartDate);
  const end = new Date(schedule.lockEndDate);
  const now = new Date();

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();

  const dayNum = Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1;
  const totalDays = schedule.lockPeriodDays;
  const percent = Math.min(100, Math.round((elapsedMs / totalMs) * 100));

  return { dayNum, totalDays, percent };
}

/**
 * Get full status object
 */
export function getStatus(schedule: Schedule): Status {
  const locked = isLocked(schedule);
  const curfewInfo = getNextCurfewInfo(schedule);
  const dayProgress = getDayProgress(schedule);
  const now = getNowInTimezone(schedule.timezone);

  return {
    active: schedule.active && locked,
    locked,
    curfewInfo,
    dayProgress,
    currentTime: now.toLocaleTimeString('en-US', { hour12: false }),
    currentDay: getDayName(now),
    timezone: schedule.timezone,
    lockEndDate: schedule.lockEndDate,
  };
}

/**
 * Create a new schedule with default values
 */
export function createDefaultSchedule(): Schedule {
  return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
}

/**
 * Activate a schedule with a lock period
 */
export function activateSchedule(schedule: Schedule, lockPeriodDays: number): Schedule {
  const now = new Date();
  const end = new Date(now.getTime() + lockPeriodDays * 24 * 60 * 60 * 1000);

  return {
    ...schedule,
    active: true,
    lockPeriodDays,
    lockStartDate: now.toISOString(),
    lockEndDate: end.toISOString(),
  };
}

/**
 * Deactivate a schedule (reset lock state)
 */
export function deactivateSchedule(schedule: Schedule): Schedule {
  return {
    ...schedule,
    active: false,
    lockPeriodDays: null,
    lockStartDate: null,
    lockEndDate: null,
  };
}

/**
 * Update schedule days
 */
export function updateScheduleDays(schedule: Schedule, days: Partial<DaysSchedule>): Schedule {
  return {
    ...schedule,
    days: { ...schedule.days, ...days },
  };
}

/**
 * Check if focus session is active
 */
export function isFocusActive(focus: FocusSession | null): boolean {
  if (!focus || !focus.active) {
    return false;
  }
  const end = new Date(focus.endTime);
  return new Date() < end;
}

/**
 * Get remaining seconds in focus session
 */
export function getFocusRemaining(focus: FocusSession | null): number {
  if (!focus || !focus.active) {
    return 0;
  }
  const end = new Date(focus.endTime);
  const remaining = Math.ceil((end.getTime() - Date.now()) / 1000);
  return Math.max(0, remaining);
}

/**
 * Create a new focus session
 */
export function createFocusSession(minutes: number): FocusSession {
  const now = new Date();
  const end = new Date(now.getTime() + minutes * 60 * 1000);

  return {
    active: true,
    startTime: now.toISOString(),
    endTime: end.toISOString(),
    minutes,
  };
}

/**
 * Schedule presets
 */
export const PRESETS: SchedulePreset[] = [
  {
    name: 'Night Owl',
    description: '10PM–6AM every day',
    getDays: () => {
      const days: DaysSchedule = {} as DaysSchedule;
      for (const day of DAYS) {
        days[day] = { curfewStart: '22:00', curfewEnd: '06:00' };
      }
      return days;
    },
  },
  {
    name: 'Early Bird',
    description: '9PM–5AM every day',
    getDays: () => {
      const days: DaysSchedule = {} as DaysSchedule;
      for (const day of DAYS) {
        days[day] = { curfewStart: '21:00', curfewEnd: '05:00' };
      }
      return days;
    },
  },
  {
    name: 'Weekend Flex',
    description: 'Weekdays 10PM–6AM, Weekends 11PM–7AM',
    getDays: () => {
      const days: DaysSchedule = {} as DaysSchedule;
      for (const day of DAYS) {
        const isWeekend = day === 'saturday' || day === 'sunday';
        days[day] = {
          curfewStart: isWeekend ? '23:00' : '22:00',
          curfewEnd: isWeekend ? '07:00' : '06:00',
        };
      }
      return days;
    },
  },
];

/**
 * Validate a schedule object
 */
export function validateSchedule(schedule: Partial<Schedule>): string[] {
  const errors: string[] = [];

  if (schedule.days) {
    for (const day of DAYS) {
      const daySchedule = schedule.days[day];
      if (daySchedule) {
        // Validate time format
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
        if (!timeRegex.test(daySchedule.curfewStart)) {
          errors.push(`Invalid curfew start time for ${day}: ${daySchedule.curfewStart}`);
        }
        if (!timeRegex.test(daySchedule.curfewEnd)) {
          errors.push(`Invalid curfew end time for ${day}: ${daySchedule.curfewEnd}`);
        }
      }
    }
  }

  if (schedule.lockPeriodDays !== undefined && schedule.lockPeriodDays !== null) {
    if (schedule.lockPeriodDays < 1 || schedule.lockPeriodDays > 365) {
      errors.push('Lock period must be between 1 and 365 days');
    }
  }

  if (schedule.timezone) {
    try {
      // Test if timezone is valid
      new Date().toLocaleString('en-US', { timeZone: schedule.timezone });
    } catch {
      errors.push(`Invalid timezone: ${schedule.timezone}`);
    }
  }

  return errors;
}

/**
 * Get curfew for a specific day
 */
export function getCurfewForDay(schedule: Schedule, day: DayName): { start: string; end: string } | null {
  const daySchedule = schedule.days[day];
  if (!daySchedule) {
    return null;
  }
  return {
    start: daySchedule.curfewStart,
    end: daySchedule.curfewEnd,
  };
}

/**
 * Copy one day's schedule to all days
 */
export function copyDayToAll(schedule: Schedule, sourceDay: DayName): Schedule {
  const sourceSchedule = schedule.days[sourceDay];
  if (!sourceSchedule) {
    return schedule;
  }

  const days: DaysSchedule = {} as DaysSchedule;
  for (const day of DAYS) {
    days[day] = { ...sourceSchedule };
  }

  return { ...schedule, days };
}
