/**
 * NightOwl Time Utilities
 * Timezone-aware time calculations
 */

import type { DayName, TimeString } from './types.js';

/**
 * Convert time string (HH:MM) to minutes since midnight
 */
export function timeToMinutes(timeStr: TimeString): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Convert minutes since midnight to time string (HH:MM)
 */
export function minutesToTime(minutes: number): TimeString {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Get current time in specified timezone
 */
export function getNowInTimezone(timezone: string): Date {
  // Create a date string in the target timezone, then parse it
  const dateStr = new Date().toLocaleString('en-US', { timeZone: timezone });
  return new Date(dateStr);
}

/**
 * Get the day name for a date
 */
export function getDayName(date: Date): DayName {
  const days: DayName[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

/**
 * Get current minutes since midnight in timezone
 */
export function getCurrentMinutesInTimezone(timezone: string): number {
  const now = getNowInTimezone(timezone);
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Check if a time (in minutes) is within a curfew period
 * Handles overnight curfews (e.g., 22:00-06:00)
 */
export function isTimeInCurfew(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin > endMin) {
    // Overnight curfew (e.g., 22:00-06:00)
    return currentMin >= startMin || currentMin < endMin;
  } else {
    // Same-day curfew (e.g., 13:00-17:00)
    return currentMin >= startMin && currentMin < endMin;
  }
}

/**
 * Calculate minutes until a target time, accounting for overnight
 */
export function minutesUntil(currentMin: number, targetMin: number): number {
  if (currentMin <= targetMin) {
    return targetMin - currentMin;
  } else {
    // Target is tomorrow
    return 1440 - currentMin + targetMin;
  }
}

/**
 * Calculate minutes remaining in a curfew period
 */
export function minutesUntilCurfewEnd(currentMin: number, startMin: number, endMin: number): number {
  if (startMin > endMin) {
    // Overnight curfew
    if (currentMin >= startMin) {
      // Before midnight
      return 1440 - currentMin + endMin;
    } else {
      // After midnight
      return endMin - currentMin;
    }
  } else {
    // Same-day curfew
    return endMin - currentMin;
  }
}

/**
 * Format minutes as HH:MM:SS countdown string
 */
export function formatCountdown(totalMins: number): string {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/**
 * Format seconds as MM:SS countdown string
 */
export function formatSecondsCountdown(totalSecs: number): string {
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Check if a date is in the past
 */
export function isPast(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d < new Date();
}

/**
 * Check if a date is in the future
 */
export function isFuture(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d > new Date();
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setTime(result.getTime() + days * 24 * 60 * 60 * 1000);
  return result;
}

/**
 * Add minutes to a date
 */
export function addMinutes(date: Date, minutes: number): Date {
  const result = new Date(date);
  result.setTime(result.getTime() + minutes * 60 * 1000);
  return result;
}

/**
 * Get remaining seconds until a target date
 */
export function secondsUntil(targetDate: Date | string): number {
  const target = typeof targetDate === 'string' ? new Date(targetDate) : targetDate;
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 1000));
}

/**
 * Get elapsed milliseconds since a date
 */
export function elapsedSince(startDate: Date | string): number {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  return Math.max(0, Date.now() - start.getTime());
}
