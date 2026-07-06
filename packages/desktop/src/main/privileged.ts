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

// Windows Task Scheduler — see createWindowsTaskXml() for the rationale.
// The task is created under the root namespace (\NightOwlDaemon) so the
// short name suffices in subsequent schtasks calls.
const WINDOWS_TASK_NAME = 'NightOwlDaemon';
const WINDOWS_INSTALL_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NightOwl');
const WINDOWS_DAEMON_EXE = path.join(WINDOWS_INSTALL_DIR, 'nightowld.exe');

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
  const installed = fs.existsSync(MACOS_PLIST_PATH);

  // System daemons live in launchd's "system" domain. `launchctl list` from a
  // user-context process (which is how Electron runs) does not surface them —
  // it only shows the user's own LaunchAgents. `launchctl print system/<label>`
  // queries the system domain without requiring sudo and exits 0 iff loaded.
  let running = false;
  if (installed) {
    try {
      await execAsync(`launchctl print system/com.nightowl.daemon`);
      running = true;
    } catch {
      try {
        // Fallback: process check by daemon script path.
        const { stdout } = await execAsync(`pgrep -f 'daemon/dist/index.js' || true`);
        running = stdout.trim().length > 0;
      } catch {
        running = false;
      }
    }
  }

  return { installed, running, platform: 'darwin' };
}

/**
 * Get Windows daemon status.
 *
 * We use a Scheduled Task (not a Windows Service) so the daemon runs in the
 * user's session and toast notifications actually reach the desktop — services
 * are stuck in Session 0 and their UI never appears. See createWindowsTaskXml().
 *
 * `schtasks /Query /FO LIST` prints lines like:
 *   TaskName:    \NightOwlDaemon
 *   Status:      Running     | Ready | Disabled | Could not start
 * We match "Running" to mean the daemon process is alive right now.
 */
async function getWindowsDaemonStatus(): Promise<{
  installed: boolean;
  running: boolean;
  platform: string;
}> {
  let installed = false;
  let running = false;

  try {
    const { stdout } = await execAsync(`schtasks /Query /TN ${WINDOWS_TASK_NAME} /FO LIST 2>nul`);
    if (stdout.includes(WINDOWS_TASK_NAME)) {
      installed = true;
      running = /Status:\s*Running/i.test(stdout);
    }
  } catch {
    // schtasks exits non-zero when the task doesn't exist — treat as "not installed".
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

  // Walk up from the script and pick the first ancestor that has a
  // node_modules directory next to it. In dev, that's
  // packages/daemon/ (next to packages/daemon/dist/). In prod, that's
  // .app/Contents/Resources/daemon/ (next to its own node_modules/).
  const daemonWorkingDir = (() => {
    let dir = path.dirname(daemonSource);
    for (let i = 0; i < 4; i++) {
      if (fs.existsSync(path.join(dir, 'node_modules'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.dirname(daemonSource);
  })();

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
 * Install Windows daemon as a Scheduled Task.
 *
 * Architecture choice (W1): we use Task Scheduler with a logon trigger +
 * minute-by-minute repetition, running as the user, NOT a Windows Service.
 *   - Services run in Session 0 — toast notifications they fire never reach
 *     the user's desktop. A silent-shutdown UX is unacceptable.
 *   - The Task Scheduler trigger fires at user logon and the daemon runs
 *     forever in the user session. The minute-repetition with
 *     MultipleInstancesPolicy=IgnoreNew acts as a watchdog: if the user kills
 *     the process, it relaunches within ~60s.
 *   - Realistic threat model is "user wants to bypass at curfew" which is
 *     always post-login. Pre-login enforcement is a v3.5 concern.
 *
 * The install flow:
 *   1. Resolve user identity + paths in the desktop's user context (BEFORE
 *      UAC elevation, because after elevation %USERNAME% / %APPDATA% refer
 *      to the admin account, not the user we want to enforce against).
 *   2. Write task XML to %TEMP%.
 *   3. Write a one-shot install .bat to %TEMP% that copies nightowld.exe into
 *      %PROGRAMDATA%\NightOwl\ and registers + starts the task.
 *   4. Run that .bat via sudo-prompt — single UAC prompt for the user.
 *   5. Clean up temp files.
 */
async function installWindowsDaemon(): Promise<{ ok: boolean; error?: string }> {
  const daemonSource = getDaemonPath();
  if (!daemonSource || !fs.existsSync(daemonSource)) {
    return { ok: false, error: 'nightowld.exe not found. Did you run `npm run build:daemon` and `npm run package:win -w packages/daemon`?' };
  }

  // Pre-elevation: capture user identity that won't survive UAC.
  const targetUser = resolveWindowsUserIdentifier();
  const dryRun = process.env.NIGHTOWL_DRY_RUN === '1';

  // Write task XML in user context (utf-16 LE BOM required by schtasks)
  const tempDir = os.tmpdir();
  const taskXmlPath = path.join(tempDir, `NightOwlDaemon-${Date.now()}.xml`);
  const xmlContent = createWindowsTaskXml({
    exePath: WINDOWS_DAEMON_EXE,
    workingDirectory: WINDOWS_INSTALL_DIR,
    userId: targetUser,
    dryRun,
  });
  // Task Scheduler requires UTF-16 LE with BOM for /XML imports.
  fs.writeFileSync(taskXmlPath, '﻿' + xmlContent, { encoding: 'utf16le' });

  // Write the install .bat that runs elevated.
  const installBatPath = path.join(tempDir, `nightowl-install-${Date.now()}.bat`);
  const installScript = [
    '@echo off',
    `if not exist "${WINDOWS_INSTALL_DIR}" mkdir "${WINDOWS_INSTALL_DIR}"`,
    `copy /Y "${daemonSource}" "${WINDOWS_DAEMON_EXE}"`,
    `if errorlevel 1 exit /b 1`,
    `schtasks /Create /XML "${taskXmlPath}" /TN ${WINDOWS_TASK_NAME} /F`,
    `if errorlevel 1 exit /b 2`,
    `schtasks /Run /TN ${WINDOWS_TASK_NAME}`,
    `exit /b 0`,
  ].join('\r\n');
  fs.writeFileSync(installBatPath, installScript);

  const sudoPrompt = await import('sudo-prompt');
  return new Promise((resolve) => {
    sudoPrompt.exec(`"${installBatPath}"`, { name: 'NightOwl' }, (error) => {
      try { fs.unlinkSync(taskXmlPath); } catch {}
      try { fs.unlinkSync(installBatPath); } catch {}

      if (error) {
        resolve({ ok: false, error: error.message || 'Installation cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Resolve a Task Scheduler-acceptable user identifier for the desktop's user.
 *
 * Task XML's `<UserId>` accepts `DOMAIN\username`, `username` (current
 * machine), or an SID. The simplest reliable form on a personal Windows box
 * is `COMPUTERNAME\username` — but for domainless local accounts, just the
 * username works too. We use `${USERDOMAIN}\${USERNAME}` when available,
 * falling back to bare `os.userInfo().username`.
 */
function resolveWindowsUserIdentifier(): string {
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  if (domain && domain.length > 0 && domain !== username) {
    return `${domain}\\${username}`;
  }
  return username;
}

/**
 * Uninstall daemon.
 *
 * Honors NIGHTOWL_UNINSTALL_DRY_RUN=1 — when set, returns ok WITHOUT touching
 * /Library/LaunchDaemons or invoking sudo-prompt. Used for dev/QA when you want
 * to exercise the IPC handler + delegation-clearing path without unloading the
 * real daemon (which would also break any live lock on this machine). Sibling
 * to NIGHTOWL_DRY_RUN which gates the daemon's halt action.
 */
export async function uninstallDaemon(): Promise<{ ok: boolean; error?: string }> {
  if (process.env.NIGHTOWL_UNINSTALL_DRY_RUN === '1') {
    console.warn('[privileged] NIGHTOWL_UNINSTALL_DRY_RUN=1 — returning ok without touching launchd or filesystem');
    return { ok: true };
  }

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
 * Uninstall Windows daemon.
 *
 * Best-effort: kill the process, delete the Scheduled Task, then remove the
 * installed .exe. Each step is followed by `2>nul || ver >nul` to swallow
 * "not found" errors without breaking the chain — uninstall should succeed
 * even on partial-install states.
 *
 * IMPORTANT: schedule.json, focus.json, and pairing state are intentionally
 * NOT deleted here. They live in %APPDATA%\NightOwl and are owned by the
 * user; preserving them lets the user re-install without losing config. The
 * Friend Lock delegation cleanup (forgetting the friend's chat_id, etc.)
 * happens at the application layer in friendlock.ts BEFORE this function is
 * called — see the daemon:uninstall IPC path.
 */
async function uninstallWindowsDaemon(): Promise<{ ok: boolean; error?: string }> {
  const sudoPrompt = await import('sudo-prompt');

  // Build the uninstall .bat in user temp so we can use multi-line clearly.
  const tempDir = os.tmpdir();
  const uninstallBatPath = path.join(tempDir, `nightowl-uninstall-${Date.now()}.bat`);
  const uninstallScript = [
    '@echo off',
    `schtasks /End /TN ${WINDOWS_TASK_NAME} 2>nul`,
    `taskkill /F /IM nightowld.exe 2>nul`,
    `schtasks /Delete /TN ${WINDOWS_TASK_NAME} /F 2>nul`,
    `if exist "${WINDOWS_DAEMON_EXE}" del /F /Q "${WINDOWS_DAEMON_EXE}"`,
    // Always exit 0 — uninstall is idempotent.
    `exit /b 0`,
  ].join('\r\n');
  fs.writeFileSync(uninstallBatPath, uninstallScript);

  return new Promise((resolve) => {
    sudoPrompt.exec(`"${uninstallBatPath}"`, { name: 'NightOwl' }, (error) => {
      try { fs.unlinkSync(uninstallBatPath); } catch {}

      if (error) {
        resolve({ ok: false, error: error.message || 'Uninstall cancelled' });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * Get path to daemon entry. On macOS the daemon ships as a Node script
 * (`dist/index.js`); on Windows we ship a self-contained executable
 * (`dist/nightowld.exe`) built via @yao-pkg/pkg so Task Scheduler has a
 * binary to launch (sc/schtasks reject .js paths).
 */
function getDaemonPath(): string | null {
  const filename = os.platform() === 'win32' ? 'nightowld.exe' : 'index.js';
  const possiblePaths = [
    // Production (packaged Electron app — extraResources copies daemon/dist → resources/daemon)
    path.join(process.resourcesPath || '', 'daemon', filename),
    // Development — when running via `npm run dev` from monorepo root
    path.join(app.getAppPath(), '..', 'daemon', 'dist', filename),
    path.join(app.getAppPath(), '..', '..', 'packages', 'daemon', 'dist', filename),
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

/**
 * Create Windows Task Scheduler XML for the daemon.
 *
 * Trigger semantics:
 *   - LogonTrigger fires once when the resolved user logs in.
 *   - The Repetition block re-triggers every minute "indefinitely"
 *     (PT1M / no Duration → repeat forever) as a watchdog. Combined with
 *     MultipleInstancesPolicy=IgnoreNew, this means: if the process is
 *     already running, the repetition is suppressed; if the user kills it,
 *     the next minute trigger brings it back.
 *
 * RunLevel=LeastPrivilege + LogonType=InteractiveToken: the daemon runs in
 * the user's session, NOT as SYSTEM. Trade-off documented at the call site.
 *
 * Dry-run mode is passed as a `--dry-run` CLI flag because Task Scheduler XML
 * has no clean way to set process environment variables on an Exec action.
 * The daemon entry parses it into NIGHTOWL_DRY_RUN internally.
 */
function createWindowsTaskXml(opts: {
  exePath: string;
  workingDirectory: string;
  userId: string;
  dryRun: boolean;
}): string {
  // XML escape the user-controlled values that go into attributes/text.
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const args = opts.dryRun ? '<Arguments>--dry-run</Arguments>' : '';

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>NightOwl curfew enforcement daemon</Description>
    <Author>NightOwl</Author>
    <URI>\\${WINDOWS_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(opts.userId)}</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(opts.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(opts.exePath)}</Command>
      ${args}
      <WorkingDirectory>${esc(opts.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}
