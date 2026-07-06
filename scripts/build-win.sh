#!/usr/bin/env bash
# Build a standalone Windows NSIS installer for NightOwl.
#
# Mirrors scripts/build-mac.sh in shape (standalone build dir to dodge npm
# workspaces hostility toward electron-builder), but much simpler: the daemon
# ships as a single nightowld.exe produced via @yao-pkg/pkg, so we do NOT need
# to vendor @nightowl/shared or bcrypt next to it. The .exe is self-contained.
#
# Can be run from macOS as an unsigned cross-build — output is a NightOwl
# Setup .exe NSIS installer that friends can download and run.
#
# Usage:
#   bash scripts/build-win.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/build/win"
OUTPUT_DIR="${ROOT}/dist"

echo "==> Cleaning previous build dir"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

echo "==> Building all packages (tsc)"
(cd "${ROOT}" && npm run build)

echo "==> Building nightowld.exe via @yao-pkg/pkg"
(cd "${ROOT}" && npm run package:win -w packages/daemon)

DAEMON_EXE="${ROOT}/packages/daemon/dist/nightowld.exe"
[ -f "${DAEMON_EXE}" ] || { echo "ERROR: nightowld.exe was not produced at ${DAEMON_EXE}"; exit 1; }
echo "    -> ${DAEMON_EXE} ($(du -h "${DAEMON_EXE}" | cut -f1))"

APP_VERSION="$(node -p "require('${ROOT}/packages/desktop/package.json').version")"

echo "==> Staging desktop app into standalone build dir"
mkdir -p "${BUILD_DIR}/app"
cp -R "${ROOT}/packages/desktop/dist" "${BUILD_DIR}/app/dist"
cp -R "${ROOT}/packages/desktop/resources" "${BUILD_DIR}/app/resources"

# Stage the daemon: ONLY the .exe, nothing else. The .exe is self-contained
# (yao-pkg bundles Node + our CJS bundle inside it).
mkdir -p "${BUILD_DIR}/daemon"
cp "${DAEMON_EXE}" "${BUILD_DIR}/daemon/nightowld.exe"

echo "==> Packing @nightowl/shared into a tarball (for desktop's runtime)"
SHARED_TGZ_DIR="${BUILD_DIR}/_tarballs"
mkdir -p "${SHARED_TGZ_DIR}"
(cd "${ROOT}/packages/shared" && npm pack --pack-destination "${SHARED_TGZ_DIR}" >/dev/null)
SHARED_TGZ="$(ls "${SHARED_TGZ_DIR}"/nightowl-shared-*.tgz | head -n1)"
echo "    -> ${SHARED_TGZ}"

# Standalone electron-builder config.
cat > "${BUILD_DIR}/app/electron-builder.yml" <<'YAML'
appId: com.nightowl.app
productName: NightOwl
copyright: Copyright © 2024

directories:
  output: ../../../dist
  buildResources: resources

files:
  - dist/**/*
  - package.json
  - "!**/*.ts"
  - "!**/*.map"

extraResources:
  - from: ../daemon
    to: daemon
    filter:
      - "**/*"

win:
  target:
    - target: nsis
      arch:
        - x64
  icon: resources/icons/icon.ico
  artifactName: "${productName}-Setup-${version}.${ext}"

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  installerIcon: resources/icons/icon.ico
  uninstallerIcon: resources/icons/icon.ico
  shortcutName: NightOwl

publish: null
YAML

echo "==> Writing standalone package.json"
cat > "${BUILD_DIR}/app/package.json" <<JSON
{
  "name": "nightowl-desktop",
  "version": "${APP_VERSION}",
  "description": "NightOwl Desktop App",
  "main": "dist/main/index.js",
  "type": "module",
  "author": "NightOwl",
  "scripts": {
    "package": "electron-builder --win --config electron-builder.yml"
  },
  "dependencies": {
    "@nightowl/shared": "file:${SHARED_TGZ}",
    "electron-store": "^8.1.0",
    "sudo-prompt": "^9.2.1"
  },
  "devDependencies": {
    "electron": "^28.1.0",
    "electron-builder": "^24.9.1"
  }
}
JSON

echo "==> Installing standalone deps"
(cd "${BUILD_DIR}/app" && npm install --include=optional --no-audit --no-fund 2>&1 | tail -20)

echo "==> Running electron-builder (unsigned NSIS)"
# Unsigned NSIS is acceptable for personal/internal use. Windows SmartScreen
# will show a warning on first run — users click "More info" → "Run anyway".
# Code signing requires a code-signing cert (~$200/yr) which is out of scope
# for W1.
(
  cd "${BUILD_DIR}/app" && \
  npx electron-builder --win --config electron-builder.yml
)

echo
echo "==> Done. Artifacts:"
ls -lh "${OUTPUT_DIR}"/*.exe 2>/dev/null || true
