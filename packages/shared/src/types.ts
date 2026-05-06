/**
 * NightOwl Type Definitions
 */

/** Time string in HH:MM format (e.g., "22:00") */
export type TimeString = string;

/** Day of the week */
export type DayName = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/** Short day name for display */
export type DayShort = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

/** Day schedule with curfew start and end times */
export interface DaySchedule {
  curfewStart: TimeString;
  curfewEnd: TimeString;
}

/** Per-day curfew schedule */
export type DaysSchedule = Record<DayName, DaySchedule>;

/** Complete schedule configuration */
export interface Schedule {
  /** Whether the schedule is currently active */
  active: boolean;
  /** Lock period in days (null if not set) */
  lockPeriodDays: number | null;
  /** ISO timestamp when lock started */
  lockStartDate: string | null;
  /** ISO timestamp when lock expires */
  lockEndDate: string | null;
  /** Per-day curfew times */
  days: DaysSchedule;
  /** IANA timezone (e.g., "Asia/Kathmandu") */
  timezone: string;
  /** Username for this schedule (macOS/Windows username) */
  user?: string;
}

/** Focus mode session */
export interface FocusSession {
  /** Whether focus mode is active */
  active: boolean;
  /** ISO timestamp when focus started */
  startTime: string;
  /** ISO timestamp when focus ends */
  endTime: string;
  /** Duration in minutes */
  minutes: number;
}

/** Curfew status information */
export interface CurfewInfo {
  /** Whether curfew is currently active */
  curfewActive: boolean;
  /** Minutes until curfew ends (0 if not in curfew) */
  minsUntilEnd: number;
  /** Minutes until curfew starts (0 if in curfew) */
  minsUntilStart: number;
  /** Curfew end time if in curfew */
  curfewEnd?: TimeString;
  /** Curfew start time if not in curfew */
  curfewStart?: TimeString;
}

/** Day progress during lock period */
export interface DayProgress {
  /** Current day number (1-based) */
  dayNum: number;
  /** Total days in lock period */
  totalDays: number;
  /** Completion percentage (0-100) */
  percent: number;
}

/** Full status response */
export interface Status {
  /** Whether schedule is active and locked */
  active: boolean;
  /** Whether currently in lock period */
  locked: boolean;
  /** Curfew timing information */
  curfewInfo: CurfewInfo | null;
  /** Lock period progress */
  dayProgress: DayProgress | null;
  /** Current time in configured timezone (HH:MM:SS) */
  currentTime: string;
  /** Current day name */
  currentDay: DayName;
  /** Configured timezone */
  timezone: string;
  /** Lock expiration date */
  lockEndDate: string | null;
}

/** Preset schedule configurations */
export interface SchedulePreset {
  name: string;
  description: string;
  getDays: () => DaysSchedule;
}

/** Platform type */
export type Platform = 'darwin' | 'win32' | 'linux';

/** Daemon status */
export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  platform: Platform;
}

/** Default schedule values */
export const DEFAULT_SCHEDULE: Schedule = {
  active: false,
  lockPeriodDays: null,
  lockStartDate: null,
  lockEndDate: null,
  days: {
    monday:    { curfewStart: '22:00', curfewEnd: '06:00' },
    tuesday:   { curfewStart: '22:00', curfewEnd: '06:00' },
    wednesday: { curfewStart: '22:00', curfewEnd: '06:00' },
    thursday:  { curfewStart: '22:00', curfewEnd: '06:00' },
    friday:    { curfewStart: '22:00', curfewEnd: '06:00' },
    saturday:  { curfewStart: '22:00', curfewEnd: '06:00' },
    sunday:    { curfewStart: '22:00', curfewEnd: '06:00' },
  },
  timezone: 'Asia/Kathmandu',
};

/** Day names array */
export const DAYS: DayName[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Day short names mapping */
export const DAY_SHORT: Record<DayName, DayShort> = {
  monday: 'MON',
  tuesday: 'TUE',
  wednesday: 'WED',
  thursday: 'THU',
  friday: 'FRI',
  saturday: 'SAT',
  sunday: 'SUN',
};
