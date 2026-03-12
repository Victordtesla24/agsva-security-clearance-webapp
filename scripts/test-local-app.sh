#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${LOCAL_APP_TEST_PORT:-3311}"
HOST="${LOCAL_APP_TEST_HOST:-127.0.0.1}"
SERVER_LOG="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-test.XXXXXX.log")"
SERVER_PID=""

cleanup() {
    if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    rm -f "${SERVER_LOG}"
}

assert_status() {
    local path="$1"
    local expected="$2"
    local body_file
    local actual=""

    body_file="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-body.XXXXXX")"
    actual="$(curl -sS -o "${body_file}" -w '%{http_code}' "http://${HOST}:${PORT}${path}")"

    if [[ "${actual}" != "${expected}" ]]; then
        printf 'Expected %s for %s, got %s\n' "${expected}" "${path}" "${actual}" >&2
        printf 'Response body:\n' >&2
        cat "${body_file}" >&2
        rm -f "${body_file}"
        exit 1
    fi

    rm -f "${body_file}"
}

assert_contains() {
    local path="$1"
    local expected="$2"
    local body_file

    body_file="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-body.XXXXXX")"
    curl -sS -o "${body_file}" "http://${HOST}:${PORT}${path}" >/dev/null

    if ! grep -Fq "${expected}" "${body_file}"; then
        printf 'Expected response for %s to contain: %s\n' "${path}" "${expected}" >&2
        printf 'Response body:\n' >&2
        cat "${body_file}" >&2
        rm -f "${body_file}"
        exit 1
    fi

    rm -f "${body_file}"
}

trap cleanup EXIT

cd "${ROOT_DIR}"
node server/local-app.mjs --host "${HOST}" --port "${PORT}" > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
sleep 1

assert_status "/" "200"
assert_contains "/" "<!DOCTYPE html>"
assert_status "/api/health" "200"
assert_contains "/api/health" "\"ok\": true"
assert_status "/.env" "404"
assert_status "/scripts/serve-draft.sh" "404"
assert_status "/server/local-app.mjs" "404"
assert_status "/%ZZ" "400"

printf 'local-app smoke tests passed\n'
