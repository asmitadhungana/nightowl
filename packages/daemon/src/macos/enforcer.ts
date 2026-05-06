/**
 * NightOwl Daemon - macOS Enforcer
 * macOS-specific curfew enforcement
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { appendLog } from '@nightowl/shared';
import type { PlatformEnforcer } from '../core/enforce.js';

const execAsync = promisify(exec);

export class MacOSEnforcer implements PlatformEnforcer {
  /**
   * Send a macOS notification
   */
  async notify(title: string, message: string): Promise<void> {
    const targetUser = process.env.NIGHTOWL_USER || 'asmeedhungana';

    // Escape quotes in message
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMessage = message.replace(/"/g, '\\"');

    const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "Submarine"`;

    try {
      // Run as target user so notification appears on their screen
      await execAsync(`sudo -u ${targetUser} osascript -e '${script}'`);
      appendLog(`Notification: ${title} - ${message}`);
    } catch (error) {
      // Try without sudo (for test mode or when running as user)
      try {
        await execAsync(`osascript -e '${script}'`);
        appendLog(`Notification (fallback): ${title} - ${message}`);
      } catch (e) {
        appendLog(`Failed to send notification: ${e}`);
      }
    }
  }

  /**
   * Kill all processes for a user
   */
  async killUserProcesses(username: string): Promise<void> {
    appendLog(`Killing processes for user: ${username}`);

    try {
      // First attempt with killall
      await execAsync(`killall -u ${username} -9 2>/dev/null || true`);
    } catch {
      // Ignore errors
    }

    try {
      // Second attempt with pkill
      await execAsync(`pkill -9 -u ${username} 2>/dev/null || true`);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Shutdown the system
   */
  async shutdown(): Promise<void> {
    appendLog('Initiating macOS shutdown');

    try {
      // Try halt first (more immediate)
      await execAsync('halt -q');
    } catch {
      try {
        // Fall back to shutdown command
        await execAsync('shutdown -h now');
      } catch {
        try {
          // Last resort
          await execAsync('/sbin/halt -q');
        } catch (e) {
          appendLog(`Failed to shutdown: ${e}`);
        }
      }
    }
  }
}
