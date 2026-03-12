#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${LOCAL_APP_TEST_PORT:-3311}"
HOST="${LOCAL_APP_TEST_HOST:-127.0.0.1}"
SERVER_LOG="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-test.XXXXXX.log")"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agsva-local-app-data.XXXXXX")"
SERVER_PID=""

request_json() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    local output_file="$4"

    if [[ -n "${body}" ]]; then
        curl -sS -X "${method}" -H 'Content-Type: application/json' -d "${body}" "http://${HOST}:${PORT}${path}" -o "${output_file}"
    else
        curl -sS -X "${method}" "http://${HOST}:${PORT}${path}" -o "${output_file}"
    fi
}

cleanup() {
    if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    rm -f "${SERVER_LOG}"
    rm -rf "${DATA_DIR}"
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
LOCAL_APP_DATA_DIR="${DATA_DIR}" node --experimental-sqlite server/local-app.mjs --host "${HOST}" --port "${PORT}" > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
sleep 1

assert_status "/" "200"
assert_contains "/" "<!DOCTYPE html>"
assert_status "/api/health" "200"
assert_contains "/api/health" "\"ok\": true"
assert_contains "/api/health" "\"state\": \"/api/app-state\""
assert_status "/.env" "404"
assert_status "/scripts/serve-draft.sh" "404"
assert_status "/server/local-app.mjs" "404"
assert_status "/%ZZ" "400"

state_file="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-state.XXXXXX.json")"
request_json "PUT" "/api/app-state" '{"state":{"progress":{"personal":100},"meta":{"smokeTest":true}}}' "${state_file}"
if ! grep -Fq '"smokeTest": true' "${state_file}"; then
    printf 'Expected saved application state response to include smokeTest flag\n' >&2
    cat "${state_file}" >&2
    rm -f "${state_file}"
    exit 1
fi
rm -f "${state_file}"

upload_body="$(node -e "const content = Buffer.from('local-app-smoke').toString('base64'); process.stdout.write(JSON.stringify({ name: 'smoke.txt.pdf', type: 'application/pdf', size: 15, category: 'other', validationState: 'valid', contentBase64: content }));")"
upload_file="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-upload.XXXXXX.json")"
request_json "POST" "/api/documents" "${upload_body}" "${upload_file}"
if ! grep -Fq '"document"' "${upload_file}"; then
    printf 'Expected document upload response to include a document payload\n' >&2
    cat "${upload_file}" >&2
    rm -f "${upload_file}"
    exit 1
fi
doc_id="$(node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(payload.document.id);" "${upload_file}")"
rm -f "${upload_file}"

assert_status "/api/documents/${doc_id}/content" "200"
assert_contains "/api/documents/${doc_id}/content" "local-app-smoke"
delete_file="$(mktemp "${TMPDIR:-/tmp}/agsva-local-app-delete.XXXXXX.json")"
request_json "DELETE" "/api/documents/${doc_id}" "" "${delete_file}"
if ! grep -Fq '"ok": true' "${delete_file}"; then
    printf 'Expected document delete response to succeed\n' >&2
    cat "${delete_file}" >&2
    rm -f "${delete_file}"
    exit 1
fi
rm -f "${delete_file}"
assert_status "/api/documents/${doc_id}/content" "404"

printf 'local-app smoke tests passed\n'
