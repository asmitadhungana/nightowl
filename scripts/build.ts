#!/usr/bin/env npx ts-node
/**
 * NightOwl Build Script
 * Builds all packages and creates distributable
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function log(message: string): void {
  console.log(`\n=== ${message} ===\n`);
}

function run(command: string, cwd?: string): void {
  console.log(`> ${command}`);
  execSync(command, {
    cwd: cwd || rootDir,
    stdio: 'inherit',
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const platform = args[0] || process.platform;

  log('Building NightOwl');
  console.log(`Platform: ${platform}`);

  // Clean previous builds
  log('Cleaning previous builds');
  run('npm run clean');

  // Install dependencies
  log('Installing dependencies');
  run('npm install');

  // Build shared package
  log('Building shared package');
  run('npm run build:shared');

  // Build daemon
  log('Building daemon');
  run('npm run build:daemon');

  // Build desktop app
  log('Building desktop app');
  run('npm run build:desktop');

  // Package for distribution
  log(`Packaging for ${platform}`);

  if (platform === 'darwin' || platform === 'mac') {
    run('npm run package:mac', path.join(rootDir, 'packages', 'desktop'));
  } else if (platform === 'win32' || platform === 'win') {
    run('npm run package:win', path.join(rootDir, 'packages', 'desktop'));
  } else {
    run('npm run package', path.join(rootDir, 'packages', 'desktop'));
  }

  log('Build complete!');
  console.log(`\nOutput files are in: ${path.join(rootDir, 'dist')}\n`);
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
