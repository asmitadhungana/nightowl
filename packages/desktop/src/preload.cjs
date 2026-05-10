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

  // v2 Friend Lock
  friendlock: {
    enroll: () => ipcRenderer.invoke('friendlock:enroll'),
    cancelPairing: () => ipcRenderer.invoke('friendlock:cancelPairing'),
    getStatus: () => ipcRenderer.invoke('friendlock:getStatus'),
    requestUninstall: () => ipcRenderer.invoke('friendlock:requestUninstall'),
    startEmergencyCooldown: () => ipcRenderer.invoke('friendlock:startEmergencyCooldown'),
    getUninstallGate: () => ipcRenderer.invoke('friendlock:getUninstallGate'),
    onPhaseChange: (cb) => {
      const handler = (_e, phase) => cb(phase);
      ipcRenderer.on('friendlock:phaseChanged', handler);
      return () => ipcRenderer.removeListener('friendlock:phaseChanged', handler);
    },
    onFriendPaired: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('friendlock:friendPaired', handler);
      return () => ipcRenderer.removeListener('friendlock:friendPaired', handler);
    },
    onBotUnreachable: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('friendlock:botUnreachable', handler);
      return () => ipcRenderer.removeListener('friendlock:botUnreachable', handler);
    },
    onUninstallDecision: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('friendlock:uninstallDecision', handler);
      return () => ipcRenderer.removeListener('friendlock:uninstallDecision', handler);
    },
    onEmergencyCooldownChanged: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('friendlock:emergencyCooldownChanged', handler);
      return () => ipcRenderer.removeListener('friendlock:emergencyCooldownChanged', handler);
    },
  },
});
