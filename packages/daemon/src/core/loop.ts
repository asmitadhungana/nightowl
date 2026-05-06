/**
 * NightOwl Daemon - Main Enforcement Loop
 * Polls schedule and enforces curfew
 */

import os from 'os';
import {
  loadSchedule,
  loadFocus,
  isLocked,
  isCurfewActive,
  isFocusActive,
  getFocusRemaining,
  getNextCurfewInfo,
  appendLog,
  lockScheduleFile,
  unlockScheduleFile,
} from '@nightowl/shared';
import { enforceCurfew } from './enforce.js';

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
const TEST_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds in test mode
const POST_ENFORCE_DEBOUNCE_MS = 30 * 1000; // 30s grace before re-evaluating

/**
 * Run the main enforcement loop. After an enforcement attempt we sleep
 * POST_ENFORCE_DEBOUNCE_MS extra so the loop doesn't immediately re-arm
 * a fresh 45s warning sequence while the OS is still in the middle of
 * shutting down (or while a dry-run notification is still on screen).
 */
export async function runEnforcementLoop(): Promise<never> {
  const testMode = process.env.NIGHTOWL_TEST_MODE === '1';
  const pollInterval = testMode ? TEST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

  while (true) {
    let didEnforce = false;
    try {
      didEnforce = await checkAndEnforce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(`Error in enforcement loop: ${message}`);
    }

    if (didEnforce && !testMode) {
      await sleep(POST_ENFORCE_DEBOUNCE_MS);
    } else {
      await sleep(pollInterval);
    }
  }
}

/**
 * Check current state and enforce if needed.
 * Returns true if enforcement was triggered (caller debounces).
 */
async function checkAndEnforce(): Promise<boolean> {
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);

  // Focus mode wins over schedule
  const focus = loadFocus();
  if (isFocusActive(focus)) {
    const remaining = getFocusRemaining(focus);
    appendLog(`[${timeStr}] FOCUS MODE ACTIVE: ${remaining} seconds remaining`);
    await enforceCurfew('immediate');
    return true;
  }

  const schedule = loadSchedule();

  // Idle: no active schedule or lock expired. Restore user ownership of
  // schedule.json so the desktop app can save edits.
  if (!schedule.active || !isLocked(schedule)) {
    appendLog(`[${timeStr}] Idle - no active schedule`);
    if (process.getuid && process.getuid() === 0) {
      // Best-effort restore. uid/gid lookup happens via the resolved user.
      try {
        const { execSync } = await import('child_process');
        const userOut = execSync(
          `id -u "${schedule.user || os.userInfo().username}" 2>/dev/null && id -g "${schedule.user || os.userInfo().username}" 2>/dev/null`,
          { encoding: 'utf8' }
        );
        const [uid, gid] = userOut.trim().split('\n').map((n) => parseInt(n, 10));
        if (Number.isFinite(uid) && Number.isFinite(gid)) {
          unlockScheduleFile(uid, gid);
        }
      } catch {
        // If we can't resolve uid/gid, leave file alone.
      }
    }
    return false;
  }

  // Active lock: protect schedule.json from casual user edits.
  lockScheduleFile();

  if (isCurfewActive(schedule)) {
    // getNextCurfewInfo only carries one side of the window depending on
    // active/inactive — pull both ends straight from the day's schedule.
    const dayName = now.toLocaleString('en-US', { weekday: 'long', timeZone: schedule.timezone }).toLowerCase();
    const day = (schedule.days as Record<string, { curfewStart: string; curfewEnd: string } | undefined>)[dayName];
    const curfewTimes = day ? `(${day.curfewStart}-${day.curfewEnd})` : '';
    appendLog(`[${timeStr}] CURFEW ACTIVE ${curfewTimes} - enforcing`);
    await enforceCurfew('normal');
    return true;
  }

  const info = getNextCurfewInfo(schedule);
  const curfewTimes = info ? `(${info.curfewStart || '??:??'})` : '';
  const minsUntil = info ? info.minsUntilStart : 0;
  appendLog(`[${timeStr}] Outside curfew ${curfewTimes}, ${minsUntil} mins until start`);
  return false;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
