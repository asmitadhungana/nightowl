/**
 * NightOwl Desktop - IPC API Handlers
 * Replaces Express HTTP API with Electron IPC
 */

import os from 'os';
import { ipcMain } from 'electron';
import {
  loadSchedule,
  saveSchedule,
  loadFocus,
  saveFocus,
  loadPasswordHash,
  savePasswordHash,
  isLocked,
  isCurfewActive,
  getStatus,
  activateSchedule,
  deactivateSchedule,
  createFocusSession,
  isFocusActive,
  getFocusRemaining,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateSchedule,
  isDelegated,
  uninstallGate,
  type Schedule,
  type FocusSession,
  type Status,
} from '@nightowl/shared';
import { getDaemonStatus, installDaemon, uninstallDaemon } from './privileged.js';
import * as friendlock from './friendlock.js';

/**
 * Set up all IPC handlers for renderer communication
 */
export function setupIpcHandlers(): void {
  // Schedule handlers
  ipcMain.handle('schedule:get', handleGetSchedule);
  ipcMain.handle('schedule:save', handleSaveSchedule);
  ipcMain.handle('schedule:activate', handleActivateSchedule);
  ipcMain.handle('schedule:deactivate', handleDeactivateSchedule);

  // Status handler
  ipcMain.handle('status:get', handleGetStatus);

  // Focus mode handlers
  ipcMain.handle('focus:get', handleGetFocus);
  ipcMain.handle('focus:start', handleStartFocus);

  // Password verification
  ipcMain.handle('password:verify', handleVerifyPassword);

  // Daemon management
  ipcMain.handle('daemon:status', handleDaemonStatus);
  ipcMain.handle('daemon:install', handleDaemonInstall);
  ipcMain.handle('daemon:uninstall', handleDaemonUninstall);

  // v2 Friend Lock — alpha set
  ipcMain.handle('friendlock:enroll', () => friendlock.enroll());
  ipcMain.handle('friendlock:cancelPairing', () => friendlock.cancelEnrollment());
  ipcMain.handle('friendlock:getStatus', () => friendlock.getDelegationStatus());
  // v2 Friend Lock — uninstall gate
  ipcMain.handle('friendlock:requestUninstall', () => friendlock.requestUninstall());
  ipcMain.handle('friendlock:cancelPendingUninstallRequest', () => friendlock.cancelPendingUninstallRequest());
  ipcMain.handle('friendlock:startEmergencyCooldown', () => friendlock.startEmergencyCooldown());
  ipcMain.handle('friendlock:getUninstallGate', () => friendlock.getUninstallGateStatus());
}

/**
 * Get current schedule
 */
async function handleGetSchedule(): Promise<Schedule> {
  return loadSchedule();
}

/**
 * Save schedule (draft, not activated)
 */
async function handleSaveSchedule(
  _event: Electron.IpcMainInvokeEvent,
  data: { days?: Schedule['days']; lockPeriodDays?: number; timezone?: string }
): Promise<{ ok: boolean; schedule: Schedule; error?: string }> {
  const schedule = loadSchedule();

  // Check if locked
  if (isLocked(schedule)) {
    return {
      ok: false,
      schedule,
      error: `Schedule is locked until ${schedule.lockEndDate}`,
    };
  }

  // Update fields
  if (data.days) schedule.days = data.days;
  if (data.lockPeriodDays !== undefined) schedule.lockPeriodDays = data.lockPeriodDays;
  if (data.timezone) schedule.timezone = data.timezone;

  // Stamp the saving user so the daemon (running as root) can restore
  // ownership of schedule.json when the lock period ends.
  if (!schedule.user) {
    schedule.user = os.userInfo().username;
  }

  // Validate
  const errors = validateSchedule(schedule);
  if (errors.length > 0) {
    return { ok: false, schedule, error: errors.join(', ') };
  }

  // Save (but don't activate)
  schedule.active = false;
  schedule.lockStartDate = null;
  schedule.lockEndDate = null;

  saveSchedule(schedule);
  return { ok: true, schedule };
}

/**
 * Activate schedule with password
 */
async function handleActivateSchedule(
  _event: Electron.IpcMainInvokeEvent,
  data: { password: string }
): Promise<{ ok: boolean; schedule: Schedule; error?: string }> {
  const { password } = data;

  // Validate password
  const validation = validatePassword(password);
  if (!validation.valid) {
    return { ok: false, schedule: loadSchedule(), error: validation.error };
  }

  const schedule = loadSchedule();

  // Check if already locked
  if (isLocked(schedule)) {
    return { ok: false, schedule, error: 'Already locked' };
  }

  // Check if lock period is set
  if (!schedule.lockPeriodDays) {
    return { ok: false, schedule, error: 'No lock period set' };
  }

  // Hash and save password
  const hash = await hashPassword(password);
  savePasswordHash(hash);

  // Activate schedule
  const activated = activateSchedule(schedule, schedule.lockPeriodDays);
  saveSchedule(activated);

  return { ok: true, schedule: activated };
}

/**
 * Deactivate schedule (requires password)
 */
async function handleDeactivateSchedule(
  _event: Electron.IpcMainInvokeEvent,
  data: { password: string }
): Promise<{ ok: boolean; schedule: Schedule; error?: string }> {
  const { password } = data;

  const schedule = loadSchedule();

  // Check if actually locked
  if (!isLocked(schedule)) {
    const deactivated = deactivateSchedule(schedule);
    saveSchedule(deactivated);
    return { ok: true, schedule: deactivated };
  }

  // Verify password
  const hash = loadPasswordHash();
  if (!hash) {
    return { ok: false, schedule, error: 'No password set' };
  }

  const valid = await verifyPassword(password, hash);
  if (!valid) {
    return { ok: false, schedule, error: 'Invalid password' };
  }

  // Deactivate
  const deactivated = deactivateSchedule(schedule);
  saveSchedule(deactivated);

  return { ok: true, schedule: deactivated };
}

/**
 * Get full status
 */
async function handleGetStatus(): Promise<Status> {
  const schedule = loadSchedule();

  // Check if lock expired
  if (schedule.active && !isLocked(schedule)) {
    // Lock expired - deactivate
    const deactivated = deactivateSchedule(schedule);
    saveSchedule(deactivated);
    return getStatus(deactivated);
  }

  return getStatus(schedule);
}

/**
 * Get focus session status
 */
async function handleGetFocus(): Promise<{
  active: boolean;
  remainingSeconds: number;
  startTime?: string;
  endTime?: string;
  minutes?: number;
}> {
  const focus = loadFocus();

  if (!focus) {
    return { active: false, remainingSeconds: 0 };
  }

  // Check if expired
  if (focus.active && !isFocusActive(focus)) {
    const expired = { ...focus, active: false };
    saveFocus(expired);
    return {
      remainingSeconds: 0,
      startTime: expired.startTime,
      endTime: expired.endTime,
      minutes: expired.minutes,
      active: false,
    };
  }

  const remaining = getFocusRemaining(focus);
  return {
    active: focus.active,
    remainingSeconds: remaining,
    startTime: focus.startTime,
    endTime: focus.endTime,
    minutes: focus.minutes,
  };
}

/**
 * Start focus session
 */
async function handleStartFocus(
  _event: Electron.IpcMainInvokeEvent,
  data: { minutes: number }
): Promise<{ ok: boolean; focus?: FocusSession; error?: string }> {
  const { minutes } = data;

  // Validate minutes
  if (!minutes || minutes < 1 || minutes > 480) {
    return { ok: false, error: 'Minutes must be between 1 and 480' };
  }

  const schedule = loadSchedule();

  // Don't allow focus during curfew
  if (schedule.active && isLocked(schedule) && isCurfewActive(schedule)) {
    return { ok: false, error: 'Already in curfew' };
  }

  // Create focus session
  const focus = createFocusSession(minutes);
  saveFocus(focus);

  return { ok: true, focus };
}

/**
 * Verify password
 */
async function handleVerifyPassword(
  _event: Electron.IpcMainInvokeEvent,
  data: { password: string }
): Promise<{ valid: boolean }> {
  const { password } = data;
  const hash = loadPasswordHash();

  if (!hash) {
    return { valid: false };
  }

  const valid = await verifyPassword(password, hash);
  return { valid };
}

/**
 * Get daemon status
 */
async function handleDaemonStatus(): Promise<{
  installed: boolean;
  running: boolean;
  platform: string;
  error?: string;
}> {
  return getDaemonStatus();
}

/**
 * Install daemon
 */
async function handleDaemonInstall(): Promise<{ ok: boolean; error?: string }> {
  return installDaemon();
}

/**
 * Uninstall daemon.
 *
 * For v1-style self-set locks: verify the user's password.
 *
 * For v2 Friend Lock: the user does NOT have the password. The gate is the
 * friend's approval (delivered via the bot) or the 72h emergency cooldown.
 * `uninstallGate` is the single source of truth — see packages/shared/src/delegation.ts.
 */
async function handleDaemonUninstall(
  _event: Electron.IpcMainInvokeEvent,
  data: { password: string }
): Promise<{ ok: boolean; error?: string }> {
  const { password } = data;
  const schedule = loadSchedule();

  if (isDelegated(schedule)) {
    const gate = uninstallGate(schedule);
    if (!gate.allowed) {
      return { ok: false, error: gate.reason };
    }
    // Approved or cooldown elapsed — proceed without password.
    const result = await uninstallDaemon();
    if (result.ok) {
      // Clear the delegation so a future re-pair starts fresh.
      schedule.delegation = null;
      saveSchedule(schedule);
    }
    return result;
  }

  // Self-set lock path: password gate.
  const hash = loadPasswordHash();
  if (hash) {
    const valid = await verifyPassword(password, hash);
    if (!valid) {
      return { ok: false, error: 'Invalid password' };
    }
  }

  return uninstallDaemon();
}
