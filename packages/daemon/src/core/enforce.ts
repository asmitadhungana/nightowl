/**
 * NightOwl Daemon - Curfew Enforcement
 * Platform-agnostic enforcement coordination
 */

import os from 'os';
import { appendLog, loadSchedule, isLocked, isCurfewActive } from '@nightowl/shared';
import { getConsoleUser } from '../macos/console-user.js';

// Platform-specific imports
let platformEnforcer: PlatformEnforcer | null = null;

export interface PlatformEnforcer {
  notify(title: string, message: string): Promise<void>;
  killUserProcesses(username: string): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Get the platform-specific enforcer
 */
async function getEnforcer(): Promise<PlatformEnforcer> {
  if (platformEnforcer) {
    return platformEnforcer;
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    const { MacOSEnforcer } = await import('../macos/enforcer.js');
    platformEnforcer = new MacOSEnforcer();
  } else if (platform === 'win32') {
    const { WindowsEnforcer } = await import('../windows/enforcer.js');
    platformEnforcer = new WindowsEnforcer();
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return platformEnforcer;
}

/**
 * Resolve the target username for enforcement.
 *
 * Order:
 *   1. NIGHTOWL_USER env (set by plist at install)
 *   2. schedule.json `user` field (set by desktop on save)
 *   3. macOS console session (`who | grep console`) — for daemons started via
 *      launchd as root, this is the actual logged-in GUI user
 *   4. os.userInfo() — last resort, returns "root" under launchd which is
 *      almost certainly wrong; emit a warning so the failure is loud.
 */
function getTargetUser(): string {
  if (process.env.NIGHTOWL_USER) {
    return process.env.NIGHTOWL_USER;
  }

  const schedule = loadSchedule();
  if (schedule.user) {
    return schedule.user;
  }

  if (os.platform() === 'darwin') {
    const consoleUser = getConsoleUser();
    if (consoleUser && consoleUser !== 'root') {
      return consoleUser;
    }
  }

  const fallback = os.userInfo().username;
  if (fallback === 'root') {
    appendLog(
      'WARNING: target user resolved to "root" — no NIGHTOWL_USER env, no schedule.user, no console session. Enforcement will not target the real user.'
    );
  }
  return fallback;
}

/**
 * Enforce curfew with warnings and shutdown.
 * @param mode 'normal' for regular curfew (with warnings), 'immediate' for focus mode
 *
 * Three runtime modes:
 *   NIGHTOWL_TEST_MODE=1 — log-only. Skips all OS calls including notifications.
 *                         Used by unit/CI tests where we just need to see the
 *                         decision flow without side effects.
 *   NIGHTOWL_DRY_RUN=1   — full warning path including notifications. Skips
 *                         only kill+halt. This is what users want for an
 *                         end-to-end smoke test on their actual machine.
 *   default              — full enforcement.
 */
export async function enforceCurfew(mode: 'normal' | 'immediate'): Promise<void> {
  const testMode = process.env.NIGHTOWL_TEST_MODE === '1';
  const dryRun = process.env.NIGHTOWL_DRY_RUN === '1';
  const targetUser = getTargetUser();

  appendLog(`=== CURFEW ENFORCEMENT (${mode}${dryRun ? ', DRY-RUN' : ''}${testMode ? ', TEST' : ''}) ===`);

  if (testMode) {
    if (mode === 'immediate') {
      appendLog('[TEST MODE] IMMEDIATE shutdown (Focus Mode)');
    } else {
      appendLog('[TEST MODE] Would send 45-second warning');
      appendLog('[TEST MODE] Would wait 30 seconds');
      appendLog('[TEST MODE] Would send 15-second warning');
      appendLog('[TEST MODE] Would wait 15 seconds');
    }
    appendLog(`[TEST MODE] Would kill processes for user: ${targetUser}`);
    appendLog('[TEST MODE] Would shutdown');
    await sleep(5000);
    return;
  }

  const enforcer = await getEnforcer();

  if (mode === 'immediate') {
    await enforcer.notify('NightOwl - FOCUS MODE', 'Locking down NOW. See you when it\'s over.');
    await sleep(3000);
  } else {
    await enforcer.notify('NightOwl', 'Computer will shut down in 45 seconds. Save your work!');
    appendLog('Sent 45-second warning');
    await sleep(30000);

    await enforcer.notify('NightOwl - FINAL WARNING', 'Shutting down in 15 seconds...');
    appendLog('Sent 15-second warning');
    await sleep(15000);

    if (!recheckCurfewActive()) {
      appendLog('Curfew ended during warning period - aborting shutdown');
      await enforcer.notify('NightOwl', 'Curfew ended. Shutdown cancelled.');
      return;
    }
  }

  if (dryRun) {
    appendLog(`[DRY-RUN] Would force-kill processes for user: ${targetUser}`);
    appendLog('[DRY-RUN] Would shutdown — skipped. Add NIGHTOWL_DRY_RUN=0 (or remove the env var) to actually enforce.');
    await enforcer.notify('NightOwl - DRY RUN', 'Curfew triggered. Shutdown skipped (dry-run).');
    return;
  }

  appendLog(`Force-killing all processes for user: ${targetUser}`);
  try {
    await enforcer.killUserProcesses(targetUser);
    await sleep(1000);
    await enforcer.killUserProcesses(targetUser);
    await sleep(1000);
  } catch (error) {
    appendLog(`Error killing processes: ${error}`);
  }

  appendLog('Initiating system shutdown');
  await enforcer.shutdown();
}

/**
 * Re-check if curfew is still active
 * Used before final shutdown to abort if curfew ended
 */
function recheckCurfewActive(): boolean {
  const schedule = loadSchedule();

  if (!schedule.active || !isLocked(schedule)) {
    return false;
  }

  return isCurfewActive(schedule);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
