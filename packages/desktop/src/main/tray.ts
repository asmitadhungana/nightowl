/**
 * NightOwl Desktop - System Tray
 * Creates and manages the system tray icon and menu
 */

import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadSchedule,
  loadFocus,
  isLocked,
  isCurfewActive,
  isFocusActive,
  getNextCurfewInfo,
} from '@nightowl/shared';
import { showMainWindow } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

/**
 * Create the system tray icon
 */
export function createTray(mainWindow: BrowserWindow | null): Tray {
  // Create a simple owl icon (we'll use a placeholder for now)
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'icons', 'trayTemplate.png');

  // Create a simple icon if file doesn't exist
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      throw new Error('Icon empty');
    }
  } catch {
    // Create a simple 16x16 icon
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('NightOwl');

  // Set up the menu
  updateTrayMenu(mainWindow);

  // Click handler - show window
  tray.on('click', () => {
    showMainWindow();
  });

  return tray;
}

/**
 * Update the tray menu based on current state
 */
export function updateTrayMenu(_mainWindow: BrowserWindow | null): void {
  if (!tray) return;

  const schedule = loadSchedule();
  const focus = loadFocus();
  const locked = isLocked(schedule);
  const focusActive = isFocusActive(focus);
  const curfewActive = schedule.active && locked && isCurfewActive(schedule);

  // Build status text
  let statusText = 'NightOwl';
  if (focusActive) {
    statusText = '⚡ Focus Mode Active';
  } else if (curfewActive) {
    statusText = '🔴 Curfew Active';
  } else if (locked) {
    const info = getNextCurfewInfo(schedule);
    if (info && !info.curfewActive) {
      const hours = Math.floor(info.minsUntilStart / 60);
      const mins = info.minsUntilStart % 60;
      statusText = `🟢 Free (${hours}h ${mins}m until curfew)`;
    } else {
      statusText = '🔒 Locked';
    }
  } else {
    statusText = '⚪ Not Active';
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: statusText,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open NightOwl',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
  ];

  // Quick focus options (only if not in curfew or focus)
  if (!curfewActive && !focusActive) {
    template.push({
      label: 'Quick Focus',
      submenu: [
        { label: '5 minutes', click: () => startQuickFocus(5) },
        { label: '15 minutes', click: () => startQuickFocus(15) },
        { label: '25 minutes', click: () => startQuickFocus(25) },
        { label: '45 minutes', click: () => startQuickFocus(45) },
        { label: '1 hour', click: () => startQuickFocus(60) },
      ],
    });
    template.push({ type: 'separator' });
  }

  // Daemon status
  template.push({
    label: 'Daemon Settings...',
    click: () => {
      showMainWindow();
      // Could send IPC to show daemon settings
    },
  });

  template.push({ type: 'separator' });

  template.push({
    label: 'Quit NightOwl',
    click: () => {
      (app as { isQuitting?: boolean }).isQuitting = true;
      app.quit();
    },
  });

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

/**
 * Start a quick focus session from tray
 */
async function startQuickFocus(minutes: number): Promise<void> {
  const { saveFocus, createFocusSession } = await import('@nightowl/shared');
  const focus = createFocusSession(minutes);
  saveFocus(focus);

  // Update tray menu
  updateTrayMenu(null);

  // Show notification
  const { Notification } = await import('electron');
  new Notification({
    title: 'NightOwl - Focus Mode',
    body: `Focus mode started for ${minutes} minutes`,
  }).show();
}

/**
 * Get the tray instance
 */
export function getTray(): Tray | null {
  return tray;
}
