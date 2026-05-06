/**
 * NightOwl Daemon - macOS Console User Resolution
 *
 * The daemon runs as root via launchd, so os.userInfo().username returns "root".
 * To enforce on the actual logged-in user, we ask the OS who's at the console.
 * `who` lists active sessions; the line whose tty is "console" is the GUI user.
 *
 * Caveats: in Fast User Switching, the most-recent console line is the
 * foreground user. SSH sessions show as ttys000 etc and are correctly ignored.
 * If no GUI user is logged in (e.g. at the loginwindow), this returns null
 * and the caller should fall through to other resolution strategies.
 */

import { execSync } from 'child_process';

let cachedUser: string | null | undefined = undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export function getConsoleUser(): string | null {
  const now = Date.now();
  if (cachedUser !== undefined && now - cachedAt < CACHE_TTL_MS) {
    return cachedUser;
  }

  cachedUser = resolveConsoleUser();
  cachedAt = now;
  return cachedUser;
}

function resolveConsoleUser(): string | null {
  try {
    const out = execSync('who', { encoding: 'utf8', timeout: 2000 });
    const lines = out.split('\n').filter(Boolean);

    // Prefer the most recent console session (Fast User Switching → last entry wins)
    let consoleUser: string | null = null;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === 'console') {
        consoleUser = parts[0];
      }
    }
    return consoleUser;
  } catch {
    return null;
  }
}

export function clearConsoleUserCache(): void {
  cachedUser = undefined;
  cachedAt = 0;
}
