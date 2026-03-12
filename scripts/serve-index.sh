#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export SERVE_SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
export SERVE_RUNTIME_BASENAME="serve-index"
export SERVE_TARGET_FILE="index.html"
export SERVE_CONSOLE_TITLE="AGSVA Index Localhost Console"
export SERVE_DEBUG_TITLE="Serve Index Diagnostics"
export SERVE_LOCAL_APP_DEFAULT_FILE="index.html"

exec "${SCRIPT_DIR}/serve-draft.sh" "$@"
