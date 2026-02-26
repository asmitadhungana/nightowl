#!/bin/bash
# NightOwl v2 Quick Installer
# Run: sudo bash install.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "Error: Run as root (sudo bash install.sh)"; exit 1; }

# Install Node.js dependencies
cd "$SCRIPT_DIR"
npm install --production

# Delegate to CLI
exec bash "$SCRIPT_DIR/nightowl.sh" install
