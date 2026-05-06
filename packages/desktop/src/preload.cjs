/**
 * NightOwl Desktop - Preload Script
 * Secure bridge between renderer and main process
 *
 * NOTE: This file uses .cjs extension to force CommonJS mode
 * because the package.json has "type": "module"
 */
const { contextBridge, ipcRenderer } = require('electron');

// Expose API to renderer
contextBridge.exposeInMainWorld('nightowl', {
  // Schedule
  getSchedule: () => ipcRenderer.invoke('schedule:get'),
  saveSchedule: (data) => ipcRenderer.invoke('schedule:save', data),
  activateSchedule: (data) => ipcRenderer.invoke('schedule:activate', data),
  deactivateSchedule: (data) => ipcRenderer.invoke('schedule:deactivate', data),

  // Status
  getStatus: () => ipcRenderer.invoke('status:get'),

  // Focus
  getFocus: () => ipcRenderer.invoke('focus:get'),
  startFocus: (data) => ipcRenderer.invoke('focus:start', data),

  // Password
  verifyPassword: (data) => ipcRenderer.invoke('password:verify', data),

  // Daemon
  getDaemonStatus: () => ipcRenderer.invoke('daemon:status'),
  installDaemon: () => ipcRenderer.invoke('daemon:install'),
  uninstallDaemon: (data) => ipcRenderer.invoke('daemon:uninstall', data),
});
