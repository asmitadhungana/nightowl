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
  // CLI flags are the only way to influence runtime mode on Windows because
  // Task Scheduler XML has no clean environment-variable injection on Exec
  // actions. On macOS the launchd plist sets these env vars instead — both
  // paths converge on the same process.env reads inside the enforcement loop.
  if (process.argv.includes('--dry-run')) {
    process.env.NIGHTOWL_DRY_RUN = '1';
  }
  if (process.argv.includes('--test-mode')) {
    process.env.NIGHTOWL_TEST_MODE = '1';
  }

  const testMode = process.env.NIGHTOWL_TEST_MODE === '1';
  const dryRun = process.env.NIGHTOWL_DRY_RUN === '1';

  appendLog('==========================================');
  appendLog(`NightOwl daemon v${VERSION} starting (PID: ${process.pid})`);
  appendLog(`Platform: ${platform}`);
  appendLog('==========================================');

  if (testMode) {
    appendLog('*** TEST MODE ACTIVE ***');
  }
  if (dryRun) {
    appendLog('*** DRY-RUN MODE — warnings + notifications fire, shutdown is skipped ***');
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
