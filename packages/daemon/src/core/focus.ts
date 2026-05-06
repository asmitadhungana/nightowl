/**
 * NightOwl Daemon - Focus Mode Handling
 * Quick lock sessions that bypass regular schedule
 */

import {
  loadFocus,
  saveFocus,
  isFocusActive as checkFocusActive,
  getFocusRemaining,
  appendLog,
  type FocusSession,
} from '@nightowl/shared';

/**
 * Check if focus mode is currently active
 */
export function isFocusModeActive(): boolean {
  const focus = loadFocus();
  return checkFocusActive(focus);
}

/**
 * Check focus mode and handle expiration
 */
export function checkFocusMode(): { active: boolean; remaining: number } {
  const focus = loadFocus();

  if (!focus) {
    return { active: false, remaining: 0 };
  }

  const active = checkFocusActive(focus);
  const remaining = getFocusRemaining(focus);

  // If focus session expired, mark as inactive
  if (focus.active && !active) {
    appendLog('Focus session expired');
    const expired: FocusSession = { ...focus, active: false };
    saveFocus(expired);
  }

  return { active, remaining };
}

/**
 * Get remaining focus time in human-readable format
 */
export function getFocusRemainingFormatted(): string {
  const focus = loadFocus();
  const remaining = getFocusRemaining(focus);

  if (remaining <= 0) {
    return '0:00';
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
