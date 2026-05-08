#!/usr/bin/env bash
# Build a standalone macOS .app + .dmg for NightOwl.
#
# Why this script exists: electron-builder's "install production dependencies"
# step does not get along with npm workspaces. Running it inside
# packages/desktop wipes out hoisted devDeps in the workspace root (notably
# 7zip-bin), which then breaks the packaging step itself.
#
# Workaround: copy the desktop app into a standalone build dir outside the
# workspace, bundle @nightowl/shared as a plain file: dependency, run a fresh
# `npm install`, and then run electron-builder from there.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/build/mac"
OUTPUT_DIR="${ROOT}/dist"

echo "==> Cleaning previous build dir"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

echo "==> Building all packages"
(cd "${ROOT}" && npm run build)

APP_VERSION="$(node -p "require('${ROOT}/packages/desktop/package.json').version")"

echo "==> Packing @nightowl/shared into a tarball"
SHARED_TGZ_DIR="${BUILD_DIR}/_tarballs"
mkdir -p "${SHARED_TGZ_DIR}"
(cd "${ROOT}/packages/shared" && npm pack --pack-destination "${SHARED_TGZ_DIR}" >/dev/null)
SHARED_TGZ="$(ls "${SHARED_TGZ_DIR}"/nightowl-shared-*.tgz | head -n1)"
echo "    -> ${SHARED_TGZ}"

echo "==> Staging desktop app into standalone build dir"
mkdir -p "${BUILD_DIR}/app"
cp -R "${ROOT}/packages/desktop/dist" "${BUILD_DIR}/app/dist"
cp -R "${ROOT}/packages/desktop/resources" "${BUILD_DIR}/app/resources"
# Write a standalone electron-builder config tailored to the build dir.
# Differences from the in-repo packages/desktop/electron-builder.yml:
#  - directories.output points at the repo dist/ (../../../dist)
#  - extraResources.from points at our staged daemon dir (with bundled deps)
#  - mac targets are arm64-only (universal builds choke on bcrypt prebuilds)
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
      - "!**/*.ts"
      - "!**/*.map"

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch:
        - arm64
    - target: zip
      arch:
        - arm64
  icon: resources/icons/icon.icns
  darkModeSupport: true
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.plist
  entitlementsInherit: resources/entitlements.plist
  artifactName: "${productName}-${version}-mac-arm64.${ext}"

dmg:
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications
  window:
    width: 540
    height: 380

publish: null
YAML

# Stage the daemon next to the desktop app. The daemon ships as a node script,
# not a compiled binary, so launchd will run it via `node Resources/daemon/index.js`
# and Node walks up from there looking for node_modules. We need to put the
# daemon's runtime deps where Node will find them.
#
# Final shape:
#   build/mac/daemon/
#     index.js, core/, macos/, ...   (from packages/daemon/dist)
#     node_modules/
#       @nightowl/shared/dist/...    (vendored, from packages/shared)
#       bcrypt/...                   (native module, hoisted from root node_modules)
#
# electron-builder.yml extraResources copies the whole tree to
# .app/Contents/Resources/daemon/
mkdir -p "${BUILD_DIR}/daemon"
cp -R "${ROOT}/packages/daemon/dist/" "${BUILD_DIR}/daemon/"
# Drop sourcemaps and .d.ts to keep the bundle small.
find "${BUILD_DIR}/daemon" -maxdepth 3 \( -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.js.map" \) -delete

# The daemon's source is ESM; without a package.json declaring
# "type": "module" Node treats `import` as a syntax error.
cat > "${BUILD_DIR}/daemon/package.json" <<JSON
{
  "name": "@nightowl/daemon",
  "version": "${APP_VERSION:-2.0.0}",
  "type": "module",
  "main": "index.js"
}
JSON

mkdir -p "${BUILD_DIR}/daemon/node_modules/@nightowl/shared"
cp -R "${ROOT}/packages/shared/dist" "${BUILD_DIR}/daemon/node_modules/@nightowl/shared/dist"
cp "${ROOT}/packages/shared/package.json" "${BUILD_DIR}/daemon/node_modules/@nightowl/shared/package.json"
find "${BUILD_DIR}/daemon/node_modules/@nightowl/shared" -name "*.d.ts" -delete
find "${BUILD_DIR}/daemon/node_modules/@nightowl/shared" -name "*.d.ts.map" -delete
find "${BUILD_DIR}/daemon/node_modules/@nightowl/shared" -name "*.js.map" -delete

# bcrypt is a native module (.node binding). Use the prebuild matching the
# host arch (we're packaging on the host, so this is fine for personal use;
# a true universal build would prebuild for both arches).
cp -R "${ROOT}/node_modules/bcrypt" "${BUILD_DIR}/daemon/node_modules/bcrypt"
# Also copy bcrypt's runtime deps that may be hoisted at the root.
for dep in node-addon-api node-gyp-build @mapbox/node-pre-gyp; do
  if [ -d "${ROOT}/node_modules/${dep}" ]; then
    target_dir="${BUILD_DIR}/daemon/node_modules/${dep}"
    mkdir -p "$(dirname "${target_dir}")"
    cp -R "${ROOT}/node_modules/${dep}" "${target_dir}"
  fi
done

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
    "package": "electron-builder --mac --config electron-builder.yml"
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


echo "==> Installing standalone deps (this is what electron-builder will see)"
(cd "${BUILD_DIR}/app" && npm install --include=optional --no-audit --no-fund 2>&1 | tail -20)

echo "==> Running electron-builder (ad-hoc signed; no Apple notarization)"
# CSC_IDENTITY_AUTO_DISCOVERY=false → don't auto-pick a Developer ID from the
# keychain. With identity: null in the config, electron-builder applies an
# ad-hoc signature, which is fine for personal/internal use. Users will need
# to right-click → Open the first time on macOS Gatekeeper.
(
  cd "${BUILD_DIR}/app" && \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac --config electron-builder.yml \
    --config.mac.identity=null
)

echo
echo "==> Done. Artifacts:"
ls -lh "${OUTPUT_DIR}"/*.dmg "${OUTPUT_DIR}"/*.zip 2>/dev/null || true
