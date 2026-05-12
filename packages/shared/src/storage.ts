/**
 * NightOwl Storage Utilities
 * File-based storage for schedule and focus data
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Schedule, FocusSession, Platform } from './types.js';
import { DEFAULT_SCHEDULE } from './types.js';

/**
 * Get the platform-specific user data directory.
 *
 * NIGHTOWL_DATA_PATH wins over platform defaults so the daemon (running as
 * root via launchd, where os.homedir() resolves to /var/root) and the desktop
 * (running as the user) can be pointed at the same file. The plist generated
 * at install time sets this env var to the installing user's path.
 */
export function getUserDataPath(): string {
  if (process.env.NIGHTOWL_DATA_PATH) {
    return process.env.NIGHTOWL_DATA_PATH;
  }

  const platform = os.platform() as Platform;

  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'NightOwl');
    case 'win32':
      return path.join(process.env.APPDATA || os.homedir(), 'NightOwl');
    default:
      return path.join(os.homedir(), '.nightowl');
  }
}

/**
 * Get the platform-specific protected data directory (root/admin owned)
 */
export function getProtectedDataPath(): string {
  const platform = os.platform() as Platform;

  switch (platform) {
    case 'darwin':
      return '/var/lib/nightowl';
    case 'win32':
      return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NightOwl');
    default:
      return '/var/lib/nightowl';
  }
}

/**
 * Ensure a directory exists
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get schedule file path
 */
export function getSchedulePath(useProtected = false): string {
  const dir = useProtected ? getProtectedDataPath() : getUserDataPath();
  return path.join(dir, 'schedule.json');
}

/**
 * Get focus file path
 */
export function getFocusPath(): string {
  return path.join(getUserDataPath(), 'focus.json');
}

/**
 * Get password hash file path
 */
export function getPasswordPath(): string {
  return path.join(getUserDataPath(), '.lock-password');
}

/**
 * Load schedule from file
 */
export function loadSchedule(filePath?: string): Schedule {
  const schedulePath = filePath || getSchedulePath();

  try {
    if (fs.existsSync(schedulePath)) {
      const data = fs.readFileSync(schedulePath, 'utf8');
      return JSON.parse(data) as Schedule;
    }
  } catch (e) {
    console.error('Error reading schedule:', e);
  }

  // Return default schedule
  return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
}

/**
 * Save schedule to file
 */
export function saveSchedule(schedule: Schedule, filePath?: string): void {
  const schedulePath = filePath || getSchedulePath();
  ensureDir(path.dirname(schedulePath));
  fs.writeFileSync(schedulePath, JSON.stringify(schedule, null, 2));
}

/**
 * Load focus session from file
 */
export function loadFocus(filePath?: string): FocusSession | null {
  const focusPath = filePath || getFocusPath();

  try {
    if (fs.existsSync(focusPath)) {
      const data = fs.readFileSync(focusPath, 'utf8');
      return JSON.parse(data) as FocusSession;
    }
  } catch (e) {
    console.error('Error reading focus:', e);
  }

  return null;
}

/**
 * Save focus session to file
 */
export function saveFocus(focus: FocusSession, filePath?: string): void {
  const focusPath = filePath || getFocusPath();
  ensureDir(path.dirname(focusPath));
  fs.writeFileSync(focusPath, JSON.stringify(focus, null, 2));
}

/**
 * Load password hash from file
 */
export function loadPasswordHash(filePath?: string): string | null {
  const passwordPath = filePath || getPasswordPath();

  try {
    if (fs.existsSync(passwordPath)) {
      return fs.readFileSync(passwordPath, 'utf8').trim();
    }
  } catch (e) {
    console.error('Error reading password hash:', e);
  }

  return null;
}

/**
 * Save password hash to file
 */
export function savePasswordHash(hash: string, filePath?: string): void {
  const passwordPath = filePath || getPasswordPath();
  ensureDir(path.dirname(passwordPath));
  fs.writeFileSync(passwordPath, hash);
}

/**
 * Get log file path
 */
export function getLogPath(): string {
  const platform = os.platform() as Platform;

  switch (platform) {
    case 'darwin':
      return '/var/log/nightowl.log';
    case 'win32':
      return path.join(getProtectedDataPath(), 'nightowl.log');
    default:
      return '/var/log/nightowl.log';
  }
}

/**
 * Append to log file
 */
export function appendLog(message: string): void {
  const logPath = getLogPath();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  try {
    ensureDir(path.dirname(logPath));
    fs.appendFileSync(logPath, line);
  } catch {
    // Log to console if file write fails
    console.log(line.trim());
  }
}

/**
 * Make schedule.json owned by root and read-only for non-root.
 * Best-effort tamper resistance during an active lock — a determined user can
 * still escalate, but the casual `vim schedule.json` bypass is closed.
 * No-op if not root or if file is missing.
 *
 * Windows: deliberately a no-op for W1. The Task Scheduler daemon runs as the
 * user (not SYSTEM) to keep toast notifications in the user session, which
 * means it has no privilege the user doesn't already have — any ACL it could
 * set, the user can unset. Real Windows lockdown would require either running
 * as SYSTEM (Session 0 → toasts don't reach the desktop) or routing every
 * schedule activation through a UAC elevation. Tracked as W2 follow-up.
 */
export function lockScheduleFile(filePath?: string): void {
  if (os.platform() === 'win32') return;
  if (process.getuid && process.getuid() !== 0) return;
  const target = filePath || getSchedulePath();
  if (!fs.existsSync(target)) return;

  try {
    const stat = fs.statSync(target);
    if (stat.uid !== 0) {
      // chown root:wheel + chmod 644: user can read, only root can write.
      fs.chownSync(target, 0, 0);
      fs.chmodSync(target, 0o644);
    }
  } catch {
    // Permission errors are expected on non-Unix or when file mid-write.
  }
}

/**
 * Restore user ownership of schedule.json so the desktop app can save again.
 * Reads the target user from the schedule's `user` field (set by desktop on save)
 * or falls back to the supplied uid/gid. No-op if not root or on Windows
 * (where lockScheduleFile is itself a no-op — see W1 note above).
 */
export function unlockScheduleFile(uid: number, gid: number, filePath?: string): void {
  if (os.platform() === 'win32') return;
  if (process.getuid && process.getuid() !== 0) return;
  const target = filePath || getSchedulePath();
  if (!fs.existsSync(target)) return;

  try {
    const stat = fs.statSync(target);
    if (stat.uid === 0) {
      fs.chownSync(target, uid, gid);
      fs.chmodSync(target, 0o644);
    }
  } catch {
    // Tolerate
  }
}
