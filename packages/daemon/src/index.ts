#!/usr/bin/env node
/**
 * NightOwl Daemon - Main Entry Point
 * Cross-platform curfew enforcement daemon
 */

import os from 'os';
import { appendLog } from '@nightowl/shared';
import { runEnforcementLoop } from './core/loop.js';

const VERSION = '2.0.0';
const platform = os.platform();

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const testMode = process.env.NIGHTOWL_TEST_MODE === '1';

  appendLog('==========================================');
  appendLog(`NightOwl daemon v${VERSION} starting (PID: ${process.pid})`);
  appendLog(`Platform: ${platform}`);
  appendLog('==========================================');

  if (testMode) {
    appendLog('*** TEST MODE ACTIVE ***');
  }

  // Handle shutdown signals gracefully
  process.on('SIGINT', () => {
    appendLog('Received SIGINT, shutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    appendLog('Received SIGTERM, shutting down...');
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    appendLog(`Uncaught exception: ${error.message}`);
    console.error(error);
  });

  process.on('unhandledRejection', (reason) => {
    appendLog(`Unhandled rejection: ${reason}`);
    console.error(reason);
  });

  // Start the enforcement loop
  await runEnforcementLoop();
}

main().catch((error) => {
  appendLog(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
