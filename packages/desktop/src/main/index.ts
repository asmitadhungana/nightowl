/**
 * NightOwl Desktop - Main Process
 * Electron main entry point
 */

import { app, BrowserWindow, nativeTheme, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { setupIpcHandlers } from './api.js';
import { createTray, updateTrayMenu } from './tray.js';
import { setupAutoLaunch } from './autolaunch.js';
import { startFriendlockPolling, stopFriendlockPolling } from './friendlock.js';
import { BOT_URL } from '@nightowl/shared';

let mainWindow: BrowserWindow | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the main window if a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
  // Force dark mode
  nativeTheme.themeSource = 'dark';

  // Use app.getAppPath() for reliable path resolution
  const appPath = app.getAppPath();
  const preloadPath = path.join(appPath, 'dist', 'preload.cjs');
  const rendererPath = path.join(appPath, 'dist', 'renderer', 'index.html');

  console.log('App path:', appPath);
  console.log('Preload path:', preloadPath);
  console.log('Preload exists:', fs.existsSync(preloadPath));
  console.log('Renderer path:', rendererPath);

  mainWindow = new BrowserWindow({
    width: 700,
    height: 900,
    minWidth: 400,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: true,
  });

  mainWindow.webContents.on('preload-error', (_event, preloadErrorPath, error) => {
    console.error('Preload error:', preloadErrorPath, error);
  });

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log('Renderer:', message);
  });

  mainWindow.loadFile(rendererPath);

  // Open DevTools for debugging
  mainWindow.webContents.openDevTools();

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show');
    mainWindow?.show();
  });

  // Handle window close - hide to tray on macOS
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !(app as AppWithQuit).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Update tray when window state changes
  mainWindow.on('show', () => updateTrayMenu(mainWindow));
  mainWindow.on('hide', () => updateTrayMenu(mainWindow));
}

// Custom property to track if quitting
interface AppWithQuit extends Electron.App {
  isQuitting?: boolean;
}

app.on('before-quit', () => {
  (app as AppWithQuit).isQuitting = true;
  stopFriendlockPolling();
});

app.whenReady().then(async () => {
  // Set up IPC handlers for renderer communication
  setupIpcHandlers();

  // Create the main window
  createWindow();

  // Create system tray
  createTray(mainWindow);

  // Set up auto-launch
  await setupAutoLaunch();

  // Start polling the bot for delegated-lock messages.
  // Idempotent — schedules a no-op tick if there's no active delegation.
  // In a packaged build, BOT_URL pointing at localhost almost certainly means the
  // operator forgot to set NIGHTOWL_BOT_URL — log loudly so it's debuggable.
  if (app.isPackaged && /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(BOT_URL)) {
    console.warn(`[friendlock] BOT_URL is "${BOT_URL}" in a packaged build. Friend Lock will not reach the deployed Worker. Set NIGHTOWL_BOT_URL before launch (see RUNBOOK.md §8).`);
  }
  startFriendlockPolling();

  // macOS specific - create window on activation if none exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });

  // Remove default menu on Windows/Linux
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Export for use in other modules
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function showMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}
