/**
 * NightOwl Desktop - Privileged Operations
 * Handles admin/root operations for daemon installation
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';

const execAsync = promisify(exec);

const MACOS_PLIST_NAME = 'com.nightowl.daemon.plist';
const MACOS_PLIST_PATH = `/Library/LaunchDaemons/${MACOS_PLIST_NAME}`;
// Legacy install location — current installs don't copy the daemon binary,
// but uninstall removes this for users upgrading from the old layout.
const MACOS_LEGACY_DAEMON_PATH = '/usr/local/bin/nightowld.js';

function resolveNodePath(): string {
  if (process.env.NIGHTOWL_NODE_BIN) return process.env.NIGHTOWL_NODE_BIN;
  try {
    const which = execSync('which node', { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {
    // fall through
  }
  for (const c of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(c)) return c;
  }
  return '/usr/local/bin/node';
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<{
  installed: boolean;
  running: boolean;
  platform: string;
  error?: string;
}> {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      return await getMacosDaemonStatus();
    } else if (platform === 'win32') {
      return await getWindowsDaemonStatus();
    } else {
      return {
        installed: false,
        running: false,
        platform,
        error: 'Unsupported platform',
      };
    }
  } catch (error) {
    return {
      installed: false,
      running: false,
      platform,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get macOS daemon status
 */
async function getMacosDaemonStatus(): Promise<{
  installed: boolean;
  running: boolean;
  platform: string;
}> {
  // Plist alone is enough — the new install model points the plist at the
  // already-built daemon dist instead of copying a binary.
  const installed = fs.existsSync(MACOS_PLIST_PATH);

  let running = false;
  if (installed) {
    try {
      const { stdout } = await execAsync(`launchctl list | grep com.nightowl.daemon || true`);
      running = stdout.includes('com.nightowl.daemon');
    } catch {
      running = false;
    }
  }

  return { installed, running, platform: 'darwin' };
}

/**
 * Get Windows daemon status
 */
async function getWindowsDaemonStatus(): Promise<{
  installed: boolean;
  running: boolean;
  platform: string;
}> {
  let installed = false;
  let running = false;

  try {
    const { stdout } = await execAsync('sc query NightOwlDaemon 2>nul || echo NOT_FOUND');
    installed = !stdout.includes('NOT_FOUND') && stdout.includes('NightOwlDaemon');
    running = stdout.includes('RUNNING');
  } catch {
    installed = false;
    running = false;
  }

  return { installed, running, platform: 'win32' };
}

/**
 * Install daemon
 */
export async function installDaemon(): Promise<{ ok: boolean; error?: string }> {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      return await installMacosDaemon();
    } else if (platform === 'win32') {
      return await installWindowsDaemon();
    } else {
      return { ok: false, error: 'Unsupported platform' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Installation failed' };
  }
}

/**
 * Install macOS daemon. We don't copy the daemon binary — instead the plist
 * points at the absolute path of the already-built `dist/index.js` in the
 * Electron app's resources, with WorkingDirectory set so Node resolves
 * `node_modules/@nightowl/shared` correctly.
 */
async function installMacosDaemon(): Promise<{ ok: boolean; error?: string }> {
  const sudoPrompt = await import('sudo-prompt');

  // Locate the daemon entry script
  const daemonSource = getDaemonPath();
  if (!daemonSource || !fs.existsSync(daemonSource)) {
    return { ok: false, error: 'Daemon entry script not found. Did you build the daemon?' };
  }

  const daemonDir = path.dirname(daemonSource);
  // node_modules lives one level up from dist/, at the package root
  const daemonWorkingDir = path.dirname(daemonDir);

  const plistContent = createMacosPlist({
    daemonScriptPath: daemonSource,
    workingDirectory: daemonWorkingDir,
  });

  const tempDir = os.tmpdir();
  const tempPlist = path.join(tempDir, MACOS_PLIST_NAME);
  fs.writeFileSync(tempPlist, plistContent);

  // Ensure log file exists & is root-writable so the daemon can append
  const commands = [
    `touch /var/log/nightowl.log`,
    `chmod 644 /var/log/nightowl.log`,
    `cp "${tempPlist}" "${MACOS_PLIST_PATH}"`,
    `chmod 644 "${MACOS_PLIST_PATH}"`,
    `launchctl load -w "${MACOS_PLIST_PATH}"`,
  ].join(' && ');

  return new Promise((resolve) => {
    sudoPrompt.exec(commands, { name: 'NightOwl' }, (error) => {
      try {
        fs.unlinkSync(tempPlist);
      } catch {}

      if (error) {
        resolve({ ok: false, error: error.message || 'Installation cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Install Windows daemon/service
 */
async function installWindowsDaemon(): Promise<{ ok: boolean; error?: string }> {
  const daemonSource = getDaemonPath();
  if (!daemonSource || !fs.existsSync(daemonSource)) {
    return { ok: false, error: 'Daemon binary not found' };
  }

  const targetPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NightOwl', 'nightowld.exe');
  const targetDir = path.dirname(targetPath);

  // Create directory and copy daemon
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.copyFileSync(daemonSource, targetPath);

  // Install as Windows service
  const sudoPrompt = await import('sudo-prompt');
  const commands = [
    `sc create NightOwlDaemon binPath="${targetPath}" start=auto`,
    `sc description NightOwlDaemon "NightOwl curfew enforcement daemon"`,
    `sc start NightOwlDaemon`,
  ].join(' && ');

  return new Promise((resolve) => {
    sudoPrompt.exec(commands, { name: 'NightOwl' }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message || 'Installation cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Uninstall daemon
 */
export async function uninstallDaemon(): Promise<{ ok: boolean; error?: string }> {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      return await uninstallMacosDaemon();
    } else if (platform === 'win32') {
      return await uninstallWindowsDaemon();
    } else {
      return { ok: false, error: 'Unsupported platform' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Uninstall failed' };
  }
}

/**
 * Uninstall macOS daemon
 */
async function uninstallMacosDaemon(): Promise<{ ok: boolean; error?: string }> {
  const sudoPrompt = await import('sudo-prompt');

  const commands = [
    `launchctl unload -w "${MACOS_PLIST_PATH}" 2>/dev/null || true`,
    `rm -f "${MACOS_PLIST_PATH}"`,
    `rm -f "${MACOS_LEGACY_DAEMON_PATH}"`,
  ].join(' && ');

  return new Promise((resolve) => {
    sudoPrompt.exec(commands, { name: 'NightOwl' }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message || 'Uninstall cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Uninstall Windows daemon
 */
async function uninstallWindowsDaemon(): Promise<{ ok: boolean; error?: string }> {
  const sudoPrompt = await import('sudo-prompt');

  const commands = [
    `sc stop NightOwlDaemon 2>nul`,
    `sc delete NightOwlDaemon`,
  ].join(' && ');

  return new Promise((resolve) => {
    sudoPrompt.exec(commands, { name: 'NightOwl' }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message || 'Uninstall cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Get path to daemon entry script. Since we ship the daemon as a Node script
 * (no compiled `pkg` binary), this resolves to the built `index.js`.
 */
function getDaemonPath(): string | null {
  const possiblePaths = [
    // Production (packaged Electron app — extraResources copies daemon/dist → resources/daemon)
    path.join(process.resourcesPath || '', 'daemon', 'index.js'),
    // Development — when running via `npm run dev` from monorepo root
    path.join(app.getAppPath(), '..', 'daemon', 'dist', 'index.js'),
    path.join(app.getAppPath(), '..', '..', 'packages', 'daemon', 'dist', 'index.js'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Create macOS LaunchDaemon plist content. The Electron app runs as the user,
 * so os.userInfo() correctly identifies who the daemon should enforce against.
 * Honors NIGHTOWL_DRY_RUN env var so users can test the warning flow without
 * the daemon actually halting their machine.
 */
function createMacosPlist(opts: {
  daemonScriptPath: string;
  workingDirectory: string;
}): string {
  // Use the user's Library data dir so daemon (root) reads what the app (user) writes.
  const dataPath = path.join(os.homedir(), 'Library', 'Application Support', 'NightOwl');
  const targetUser = os.userInfo().username;
  const nodeBin = resolveNodePath();
  const dryRun = process.env.NIGHTOWL_DRY_RUN === '1'
    ? '<key>NIGHTOWL_DRY_RUN</key><string>1</string>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nightowl.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${opts.daemonScriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${opts.workingDirectory}</string>
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
