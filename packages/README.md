# NightOwl Packages

This monorepo contains three packages:

## @nightowl/shared

Platform-agnostic TypeScript utilities:
- Schedule parsing and curfew detection
- Time/timezone handling
- Password hashing (bcrypt)
- Storage utilities

## @nightowl/daemon

Background daemon for curfew enforcement:
- Runs as root/admin
- Polls schedule every 60 seconds
- Sends warning notifications before shutdown
- Kills user processes and shuts down during curfew
- Platform-specific enforcers for macOS and Windows

## @nightowl/desktop

Electron desktop application:
- Cross-platform GUI
- System tray integration
- IPC-based API (replaces HTTP)
- Daemon installation/management

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run in development mode
npm run dev

# Run tests
npm test

# Package for distribution
npm run package:mac  # macOS DMG
npm run package:win  # Windows installer
```

## Test Mode

Run the daemon in test mode (no actual shutdown):
```bash
NIGHTOWL_TEST_MODE=1 npm run dev:daemon
```
