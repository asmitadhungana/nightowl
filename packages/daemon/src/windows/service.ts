/**
 * NightOwl Daemon - Windows Service Management
 * Windows Service installation and management
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { appendLog, getProtectedDataPath } from '@nightowl/shared';

const execAsync = promisify(exec);

const SERVICE_NAME = 'NightOwlDaemon';
const DAEMON_PATH = path.join(getProtectedDataPath(), 'nightowld.exe');

/**
 * Check if the daemon is installed
 */
export async function isDaemonInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`sc query ${SERVICE_NAME} 2>nul`);
    return stdout.includes(SERVICE_NAME);
  } catch {
    return false;
  }
}

/**
 * Check if the daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`sc query ${SERVICE_NAME} 2>nul`);
    return stdout.includes('RUNNING');
  } catch {
    return false;
  }
}

/**
 * Install the daemon as a Windows Service (requires admin)
 */
export async function installDaemon(daemonBinaryPath: string): Promise<void> {
  // Create directory
  const targetDir = path.dirname(DAEMON_PATH);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy binary
  fs.copyFileSync(daemonBinaryPath, DAEMON_PATH);

  // Create the service
  await execAsync(`sc create ${SERVICE_NAME} binPath="${DAEMON_PATH}" start=auto`);
  await execAsync(`sc description ${SERVICE_NAME} "NightOwl curfew enforcement daemon"`);

  // Set recovery options (restart on failure)
  await execAsync(`sc failure ${SERVICE_NAME} reset=86400 actions=restart/5000/restart/10000/restart/30000`);

  // Start the service
  await execAsync(`sc start ${SERVICE_NAME}`);

  appendLog('Windows service installed and started');
}

/**
 * Uninstall the daemon (requires admin)
 */
export async function uninstallDaemon(): Promise<void> {
  try {
    await execAsync(`sc stop ${SERVICE_NAME} 2>nul`);
  } catch {
    // Ignore
  }

  try {
    await execAsync(`sc delete ${SERVICE_NAME}`);
  } catch {
    // Ignore
  }

  try {
    fs.unlinkSync(DAEMON_PATH);
  } catch {
    // Ignore
  }

  appendLog('Windows service uninstalled');
}

/**
 * Restart the daemon
 */
export async function restartDaemon(): Promise<void> {
  try {
    await execAsync(`sc stop ${SERVICE_NAME}`);
    await execAsync(`sc start ${SERVICE_NAME}`);
    appendLog('Windows service restarted');
  } catch (e) {
    appendLog(`Failed to restart Windows service: ${e}`);
    throw e;
  }
}

/**
 * Get service status
 */
export async function getServiceStatus(): Promise<{
  installed: boolean;
  running: boolean;
  state: string;
}> {
  try {
    const { stdout } = await execAsync(`sc query ${SERVICE_NAME} 2>nul`);

    if (!stdout.includes(SERVICE_NAME)) {
      return { installed: false, running: false, state: 'not_installed' };
    }

    const running = stdout.includes('RUNNING');
    const stopped = stdout.includes('STOPPED');

    return {
      installed: true,
      running,
      state: running ? 'running' : stopped ? 'stopped' : 'unknown',
    };
  } catch {
    return { installed: false, running: false, state: 'error' };
  }
}
