/**
 * NightOwl Daemon - macOS Service Management
 * LaunchDaemon installation and management
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import { appendLog, getUserDataPath } from '@nightowl/shared';

const execAsync = promisify(exec);

const PLIST_NAME = 'com.nightowl.daemon.plist';
const DAEMON_PATH = '/usr/local/bin/nightowld.js';
const PLIST_PATH = `/Library/LaunchDaemons/${PLIST_NAME}`;

/**
 * Resolve the absolute path to the node binary at install time.
 * launchd runs daemons with a minimal PATH, so the plist must hard-code the
 * node location. Probes common Homebrew + nvm + system locations.
 */
function resolveNodePath(): string {
  if (process.env.NIGHTOWL_NODE_BIN) return process.env.NIGHTOWL_NODE_BIN;

  try {
    const which = execSync('which node', { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {
    // fall through
  }

  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    `${os.homedir()}/.nvm/versions/node/`,
    '/usr/bin/node',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Last resort — install will likely fail loudly if this is wrong.
  return '/usr/local/bin/node';
}

/**
 * Resolve the user that the daemon should enforce against. The Electron app
 * runs as the user, so capturing this at install time is correct.
 */
function resolveInstallUser(): string {
  // SUDO_USER is set when the install command was invoked with sudo
  if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
    return process.env.SUDO_USER;
  }
  return os.userInfo().username;
}

/**
 * Check if the daemon is installed
 */
export async function isDaemonInstalled(): Promise<boolean> {
  return fs.existsSync(PLIST_PATH) && fs.existsSync(DAEMON_PATH);
}

/**
 * Check if the daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`launchctl list | grep com.nightowl.daemon || true`);
    return stdout.includes('com.nightowl.daemon');
  } catch {
    return false;
  }
}

/**
 * Generate the LaunchDaemon plist content.
 *
 * Critical env vars:
 *   NIGHTOWL_DATA_PATH — daemon and desktop must agree on this path
 *   NIGHTOWL_USER      — captured from the installing user, since
 *                        os.userInfo() under launchd returns "root"
 *   NIGHTOWL_DRY_RUN   — when "1", warnings + notifications fire but
 *                        no kill/halt. For end-to-end macOS testing.
 */
export function generatePlist(opts: { dryRun?: boolean } = {}): string {
  const dataPath = getUserDataPath();
  const targetUser = resolveInstallUser();
  const nodeBin = resolveNodePath();
  const dryRun = opts.dryRun ? '<key>NIGHTOWL_DRY_RUN</key><string>1</string>' : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nightowl.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${DAEMON_PATH}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NIGHTOWL_DATA_PATH</key>
        <string>${dataPath}</string>
        <key>NIGHTOWL_USER</key>
        <string>${targetUser}</string>
        ${dryRun}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/nightowl.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/nightowl.log</string>
</dict>
</plist>`;
}

/**
 * Install the daemon (requires root)
 */
export async function installDaemon(daemonBinaryPath: string): Promise<void> {
  // Copy binary
  fs.copyFileSync(daemonBinaryPath, DAEMON_PATH);
  fs.chmodSync(DAEMON_PATH, 0o755);

  // Write plist
  const plistContent = generatePlist();
  fs.writeFileSync(PLIST_PATH, plistContent);
  fs.chmodSync(PLIST_PATH, 0o644);

  // Load daemon
  await execAsync(`launchctl load -w ${PLIST_PATH}`);

  appendLog('Daemon installed and started');
}

/**
 * Uninstall the daemon (requires root)
 */
export async function uninstallDaemon(): Promise<void> {
  try {
    await execAsync(`launchctl unload -w ${PLIST_PATH} 2>/dev/null || true`);
  } catch {
    // Ignore
  }

  try {
    fs.unlinkSync(PLIST_PATH);
  } catch {
    // Ignore
  }

  try {
    fs.unlinkSync(DAEMON_PATH);
  } catch {
    // Ignore
  }

  appendLog('Daemon uninstalled');
}

/**
 * Restart the daemon
 */
export async function restartDaemon(): Promise<void> {
  try {
    await execAsync(`launchctl unload ${PLIST_PATH}`);
    await execAsync(`launchctl load ${PLIST_PATH}`);
    appendLog('Daemon restarted');
  } catch (e) {
    appendLog(`Failed to restart daemon: ${e}`);
    throw e;
  }
}
