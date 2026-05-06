/**
 * NightOwl Desktop - Auto Launch
 * Manages app auto-start on system boot
 */

import { app } from 'electron';

/**
 * Set up auto-launch on system startup
 */
export async function setupAutoLaunch(): Promise<void> {
  // Only enable auto-launch in production
  if (!app.isPackaged) {
    return;
  }

  const settings = app.getLoginItemSettings();

  // Enable auto-launch if not already enabled
  if (!settings.openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // Start minimized to tray
    });
  }
}

/**
 * Enable or disable auto-launch
 */
export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
  });
}

/**
 * Check if auto-launch is enabled
 */
export function isAutoLaunchEnabled(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}
