/**
 * NightOwl Daemon - Windows Enforcer
 * Windows-specific curfew enforcement
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { appendLog } from '@nightowl/shared';
import type { PlatformEnforcer } from '../core/enforce.js';

const execAsync = promisify(exec);

export class WindowsEnforcer implements PlatformEnforcer {
  /**
   * Send a Windows toast notification
   */
  async notify(title: string, message: string): Promise<void> {
    // Escape single quotes
    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");

    // PowerShell toast notification script
    const script = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
      $template = @"
      <toast>
        <visual>
          <binding template="ToastText02">
            <text id="1">${safeTitle}</text>
            <text id="2">${safeMessage}</text>
          </binding>
        </visual>
        <audio src="ms-winsoundevent:Notification.Default"/>
      </toast>
"@
      $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
      $xml.LoadXml($template)
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NightOwl").Show($toast)
    `;

    try {
      await execAsync(`powershell -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
      appendLog(`Notification: ${title} - ${message}`);
    } catch (error) {
      // Fallback to msg.exe for simpler notification
      try {
        await execAsync(`msg * /TIME:10 "${safeTitle}: ${safeMessage}"`);
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
      // Kill all processes for the user
      await execAsync(`taskkill /F /FI "USERNAME eq ${username}" 2>nul || exit 0`);
    } catch {
      // Ignore errors
    }

    try {
      // Kill explorer.exe specifically to ensure desktop is killed
      await execAsync(`taskkill /F /IM explorer.exe /FI "USERNAME eq ${username}" 2>nul || exit 0`);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Shutdown the system
   */
  async shutdown(): Promise<void> {
    appendLog('Initiating Windows shutdown');

    try {
      // Force shutdown immediately
      await execAsync('shutdown /s /f /t 0');
    } catch (e) {
      appendLog(`Failed to shutdown: ${e}`);
    }
  }
}
