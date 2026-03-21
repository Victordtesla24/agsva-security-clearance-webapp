#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/.firebase-dist"

node "${ROOT_DIR}/scripts/sync-firebase-config.mjs" --allow-empty-output

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

cp "${ROOT_DIR}/index.html" "${DIST_DIR}/"
cp "${ROOT_DIR}/app-runtime.js" "${DIST_DIR}/"
cp "${ROOT_DIR}/firebase-config.js" "${DIST_DIR}/"
touch "${DIST_DIR}/.nojekyll"
