#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Git repository required for hygiene checks.\n' >&2
    exit 1
fi

tracked_files="$(git -C "${ROOT_DIR}" ls-files)"
blocked_patterns=(
    '^\.env$'
    '^artifacts/'
    '(^|/)\.DS_Store$'
)

for pattern in "${blocked_patterns[@]}"; do
    if printf '%s\n' "${tracked_files}" | grep -Eq "${pattern}"; then
        printf 'Blocked tracked file matched pattern: %s\n' "${pattern}" >&2
        exit 1
    fi
done

required_files=(
    ".env.example"
    "SECURITY.md"
    "README.md"
    "index.html"
    "server/local-app.mjs"
    "scripts/serve-draft.sh"
    "scripts/serve-index.sh"
    "scripts/test-local-app.sh"
    ".github/workflows/ci.yml"
    ".github/workflows/repo-hygiene.yml"
    ".github/workflows/codeql.yml"
    ".github/pull_request_template.md"
)

for required_file in "${required_files[@]}"; do
    if [[ ! -f "${ROOT_DIR}/${required_file}" ]]; then
        printf 'Missing required repository file: %s\n' "${required_file}" >&2
        exit 1
    fi
done

printf 'repository hygiene checks passed\n'
