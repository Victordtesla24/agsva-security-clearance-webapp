#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_NAME="${SERVE_SCRIPT_NAME:-$(basename "${BASH_SOURCE[0]}")}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/artifacts/server"
RUNTIME_BASENAME="${SERVE_RUNTIME_BASENAME:-serve-draft}"
TARGET_FILE="${SERVE_TARGET_FILE:-draft.html}"
SERVER_ENTRYPOINT="${ROOT_DIR}/server/local-app.mjs"
ENV_FILE="${ROOT_DIR}/.env"
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="3000"
DEFAULT_COMMAND="menu"
READINESS_TIMEOUT_SECONDS=15
TAIL_LINES=80
CONSOLE_TITLE="${SERVE_CONSOLE_TITLE:-AGSVA Draft Localhost Console}"
DEBUG_TITLE="${SERVE_DEBUG_TITLE:-Serve Draft Diagnostics}"
LOCAL_APP_DEFAULT_FILE="${SERVE_LOCAL_APP_DEFAULT_FILE:-${TARGET_FILE}}"

COMMAND="${DEFAULT_COMMAND}"
HOST="${DEFAULT_HOST}"
PORT="${DEFAULT_PORT}"
OPEN_BROWSER=0
FOLLOW_LOGS=0
NO_COLOR=0

C_RESET=""
C_BOLD=""
C_DIM=""
C_INK=""
C_TEAL=""
C_STONE=""
C_SUCCESS=""
C_WARN=""
C_DANGER=""

STATE_HOST=""
STATE_PORT=""
STATE_PID=""
STATE_ROOT_DIR=""
STATE_URL=""
STATE_STARTED_AT=""
STATE_STARTED_EPOCH=""
STATE_SERVER_COMMAND=""
STATE_TARGET_FILE=""

usage() {
    cat <<EOF
Usage: ${SCRIPT_NAME} [command] [options]

Commands:
  start       Start the managed localhost server
  stop        Stop the managed localhost server
  restart     Restart the managed localhost server
  status      Show server health, URL, and process state
  logs        Show recent server logs
  debug       Show extended diagnostics
  open        Open the served page in the default browser
  menu        Launch the interactive operator console
  help        Show this help

Options:
  --host <host>      Bind host (default: ${DEFAULT_HOST})
  --port <port>      Bind port (default: ${DEFAULT_PORT})
  --open             Open the page after a successful start
  --follow, -f       Follow logs for the logs command
  --no-color         Disable ANSI styling
  --help, -h         Show this help

Examples:
  ${SCRIPT_NAME} start
  ${SCRIPT_NAME} start --port 3100 --open
  ${SCRIPT_NAME} status
  ${SCRIPT_NAME} logs --follow
EOF
}

parse_args() {
    if [[ $# -gt 0 && "${1#-}" == "$1" ]]; then
        COMMAND="$1"
        shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host)
                HOST="${2:-}"
                shift 2
                ;;
            --host=*)
                HOST="${1#*=}"
                shift
                ;;
            --port)
                PORT="${2:-}"
                shift 2
                ;;
            --port=*)
                PORT="${1#*=}"
                shift
                ;;
            --open)
                OPEN_BROWSER=1
                shift
                ;;
            --follow|-f)
                FOLLOW_LOGS=1
                shift
                ;;
            --no-color)
                NO_COLOR=1
                shift
                ;;
            --help|-h)
                COMMAND="help"
                shift
                ;;
            *)
                printf 'Unknown argument: %s\n' "$1" >&2
                exit 1
                ;;
        esac
    done
}

init_colors() {
    if [[ ${NO_COLOR} -eq 0 && -t 1 ]]; then
        C_RESET=$'\033[0m'
        C_BOLD=$'\033[1m'
        C_DIM=$'\033[2m'
        C_INK=$'\033[38;5;239m'
        C_TEAL=$'\033[38;5;37m'
        C_STONE=$'\033[38;5;137m'
        C_SUCCESS=$'\033[38;5;36m'
        C_WARN=$'\033[38;5;172m'
        C_DANGER=$'\033[38;5;160m'
    fi
}

validate_options() {
    if [[ -z "${HOST}" ]]; then
        fail "Host cannot be empty."
    fi

    if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
        fail "Port must be an integer between 1 and 65535."
    fi
}

ensure_runtime_dir() {
    mkdir -p "${RUNTIME_DIR}"
}

reset_loaded_state() {
    STATE_HOST=""
    STATE_PORT=""
    STATE_PID=""
    STATE_ROOT_DIR=""
    STATE_URL=""
    STATE_STARTED_AT=""
    STATE_STARTED_EPOCH=""
    STATE_SERVER_COMMAND=""
    STATE_TARGET_FILE=""
}

sanitize_runtime_fragment() {
    local value="$1"

    value="$(printf '%s' "${value}" | tr -c 'A-Za-z0-9._-' '_')"
    value="${value#_}"
    value="${value%_}"

    if [[ -z "${value}" ]]; then
        value="default"
    fi

    printf '%s' "${value}"
}

target_path_is_safe() {
    local candidate="$1"
    local segment=""
    local first_segment=""
    local -a parts=()

    [[ -n "${candidate}" ]] || return 1
    [[ "${candidate}" == *.html ]] || return 1
    [[ "${candidate}" != /* ]] || return 1
    [[ "${candidate}" != *$'\n'* ]] || return 1
    [[ "${candidate}" != *[[:space:]]* ]] || return 1

    IFS='/' read -r -a parts <<< "${candidate}"
    first_segment="${parts[0]:-}"

    case "${first_segment}" in
        artifacts|docs|node_modules|scripts|server)
            return 1
            ;;
    esac

    for segment in "${parts[@]}"; do
        [[ -n "${segment}" ]] || return 1
        [[ "${segment}" != "." && "${segment}" != ".." ]] || return 1
        [[ "${segment}" != .* ]] || return 1
    done

    return 0
}

resolve_target_file() {
    local requested_target="${TARGET_FILE}"
    local candidate=""
    local resolved=""
    local old_ifs="${IFS}"

    IFS=$'\n'
    for candidate in "${TARGET_FILE}" "${LOCAL_APP_DEFAULT_FILE}" "draft.html" "index.html"; do
        [[ -n "${candidate}" ]] || continue

        candidate="${candidate#./}"
        candidate="${candidate#/}"

        if ! target_path_is_safe "${candidate}"; then
            continue
        fi

        if [[ -f "${ROOT_DIR}/${candidate}" ]]; then
            resolved="${candidate}"
            break
        fi
    done
    IFS="${old_ifs}"

    if [[ -z "${resolved}" ]]; then
        fail "No readable HTML entrypoint was found under ${ROOT_DIR}."
    fi

    TARGET_FILE="${resolved}"
    LOCAL_APP_DEFAULT_FILE="${resolved}"

    if [[ "${requested_target}" != "${resolved}" ]]; then
        warn "Resolved target file to ${resolved}."
    fi
}

runtime_token() {
    local host_fragment

    host_fragment="$(sanitize_runtime_fragment "${HOST}")"
    printf '%s-%s-%s' "${RUNTIME_BASENAME}" "${host_fragment}" "${PORT}"
}

pid_file() {
    printf '%s/%s.pid' "${RUNTIME_DIR}" "$(runtime_token)"
}

state_file() {
    printf '%s/%s.env' "${RUNTIME_DIR}" "$(runtime_token)"
}

log_file() {
    printf '%s/%s.log' "${RUNTIME_DIR}" "$(runtime_token)"
}

timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

epoch_now() {
    date '+%s'
}

log_event() {
    local level="$1"
    local log_file_path=""
    shift

    ensure_runtime_dir
    log_file_path="$(log_file)"
    printf '%s [%s] %s\n' "$(timestamp)" "${level}" "$*" >> "${log_file_path}"
}

strip_colors() {
    printf '%s' "$*"
}

print_line() {
    local char="${1:--}"
    local width=78
    local line=""
    local i=0

    while (( i < width )); do
        line="${line}${char}"
        i=$(( i + 1 ))
    done

    printf '%s\n' "${line}"
}

print_header() {
    local title="$1"
    printf '%s' "${C_BOLD}${C_TEAL}"
    print_line "="
    printf '  %s\n' "${title}"
    printf '%s' "${C_RESET}"
    print_line "-"
}

print_kv() {
    local key="$1"
    local value="$2"
    printf '  %-18s %s\n' "${key}" "${value}"
}

info() {
    printf '%sINFO%s  %s\n' "${C_TEAL}" "${C_RESET}" "$*"
}

success() {
    printf '%sOK%s    %s\n' "${C_SUCCESS}" "${C_RESET}" "$*"
}

warn() {
    printf '%sWARN%s  %s\n' "${C_WARN}" "${C_RESET}" "$*"
}

error() {
    printf '%sERR%s   %s\n' "${C_DANGER}" "${C_RESET}" "$*" >&2
}

fail() {
    error "$*"
    log_event "ERROR" "$*"
    exit 1
}

supports_spinner() {
    [[ -t 1 && -z "${CI:-}" ]]
}

run_with_spinner() {
    local label="$1"
    shift
    local spinner='|/-\'
    local spinner_len=4
    local frame_index=0
    local worker_pid
    local status

    if ! supports_spinner; then
        "$@"
        return $?
    fi

    "$@" &
    worker_pid=$!

    while kill -0 "${worker_pid}" 2>/dev/null; do
        printf '\r%s[%s]%s %s' "${C_TEAL}" "${spinner:frame_index:1}" "${C_RESET}" "${label}"
        frame_index=$(( (frame_index + 1) % spinner_len ))
        sleep 0.12
    done

    wait "${worker_pid}"
    status=$?
    printf '\r%*s\r' 90 ' '
    return "${status}"
}

require_commands() {
    local missing=0
    local dependency

    for dependency in "$@"; do
        if ! command -v "${dependency}" >/dev/null 2>&1; then
            error "Missing dependency: ${dependency}"
            missing=1
        fi
    done

    if (( missing > 0 )); then
        exit 1
    fi
}

load_state() {
    local state_file_path=""
    local exported_state=""

    reset_loaded_state
    state_file_path="$(state_file)"

    if [[ -f "${state_file_path}" ]]; then
        exported_state="$(
            STATE_FILE_PATH="${state_file_path}" bash -c '
                # shellcheck disable=SC1090
                source "$STATE_FILE_PATH"
                printf "STATE_HOST=%q\n" "${HOST:-}"
                printf "STATE_PORT=%q\n" "${PORT:-}"
                printf "STATE_PID=%q\n" "${PID:-}"
                printf "STATE_ROOT_DIR=%q\n" "${ROOT_DIR:-}"
                printf "STATE_URL=%q\n" "${URL:-}"
                printf "STATE_STARTED_AT=%q\n" "${STARTED_AT:-}"
                printf "STATE_STARTED_EPOCH=%q\n" "${STARTED_EPOCH:-}"
                printf "STATE_SERVER_COMMAND=%q\n" "${SERVER_COMMAND:-}"
                printf "STATE_TARGET_FILE=%q\n" "${TARGET_FILE:-}"
            '
        )"

        if [[ -n "${exported_state}" ]]; then
            eval "${exported_state}"
        fi
    fi
}

persist_state() {
    local pid="$1"
    local command_line="$2"
    local started_epoch
    local started_at
    local pid_file_path=""
    local state_file_path=""

    started_epoch="$(epoch_now)"
    started_at="$(timestamp)"
    pid_file_path="$(pid_file)"
    state_file_path="$(state_file)"

    ensure_runtime_dir
    printf '%s\n' "${pid}" > "${pid_file_path}"
    {
        printf 'HOST=%q\n' "${HOST}"
        printf 'PORT=%q\n' "${PORT}"
        printf 'PID=%q\n' "${pid}"
        printf 'ROOT_DIR=%q\n' "${ROOT_DIR}"
        printf 'URL=%q\n' "$(server_url)"
        printf 'STARTED_AT=%q\n' "${started_at}"
        printf 'STARTED_EPOCH=%q\n' "${started_epoch}"
        printf 'SERVER_COMMAND=%q\n' "${command_line}"
        printf 'TARGET_FILE=%q\n' "${TARGET_FILE}"
    } > "${state_file_path}"
}

clear_state() {
    local pid_file_path=""
    local state_file_path=""

    pid_file_path="$(pid_file)"
    state_file_path="$(state_file)"

    rm -f "${pid_file_path}" "${state_file_path}"
    reset_loaded_state
}

managed_pid() {
    local pid_file_path=""

    pid_file_path="$(pid_file)"

    if [[ -f "${pid_file_path}" ]]; then
        tr -d '[:space:]' < "${pid_file_path}"
    fi
}

is_pid_running() {
    local pid="$1"
    [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

pid_command() {
    local pid="$1"
    ps -ww -p "${pid}" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'
}

server_url() {
    printf 'http://%s:%s/%s' "${HOST}" "${PORT}" "${TARGET_FILE}"
}

health_url() {
    printf 'http://%s:%s/api/health' "${HOST}" "${PORT}"
}

listener_pids_for_port() {
    lsof -tiTCP:"${PORT}" -sTCP:LISTEN -n -P 2>/dev/null || true
}

listener_details_for_port() {
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

port_is_in_use() {
    [[ -n "$(listener_pids_for_port)" ]]
}

pid_is_listener_for_port() {
    local pid="$1"
    local listener_pid

    while IFS= read -r listener_pid; do
        if [[ "${listener_pid}" == "${pid}" ]]; then
            return 0
        fi
    done < <(listener_pids_for_port)

    return 1
}

cleanup_stale_state() {
    local pid

    pid="$(managed_pid || true)"
    if [[ -z "${pid}" ]]; then
        return 0
    fi

    if ! is_pid_running "${pid}"; then
        warn "Removing stale runtime metadata for PID ${pid}."
        log_event "WARN" "Removing stale runtime metadata for PID ${pid}."
        clear_state
    fi
}

managed_server_running() {
    local pid

    cleanup_stale_state
    pid="$(managed_pid || true)"

    if [[ -z "${pid}" ]]; then
        return 1
    fi

    if ! is_pid_running "${pid}"; then
        return 1
    fi

    if ! pid_is_listener_for_port "${pid}"; then
        return 1
    fi

    return 0
}

http_status_code() {
    local url="$1"
    curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "${url}" 2>/dev/null || true
}

wait_for_ready() {
    local url="$1"
    local attempts=0
    local max_attempts=$(( READINESS_TIMEOUT_SECONDS * 4 ))
    local code

    while (( attempts < max_attempts )); do
        code="$(http_status_code "${url}")"
        if [[ "${code}" == "200" ]]; then
            return 0
        fi

        sleep 0.25
        attempts=$(( attempts + 1 ))
    done

    return 1
}

wait_for_process_exit() {
    local pid="$1"
    local timeout_seconds="$2"
    local elapsed=0

    while is_pid_running "${pid}" && (( elapsed < timeout_seconds * 4 )); do
        sleep 0.25
        elapsed=$(( elapsed + 1 ))
    done

    ! is_pid_running "${pid}"
}

format_uptime() {
    local started_epoch="$1"
    local now
    local seconds
    local hours
    local minutes

    if [[ -z "${started_epoch}" ]]; then
        printf 'n/a'
        return
    fi

    now="$(epoch_now)"
    seconds=$(( now - started_epoch ))
    hours=$(( seconds / 3600 ))
    minutes=$(( (seconds % 3600) / 60 ))
    seconds=$(( seconds % 60 ))

    printf '%02dh %02dm %02ds' "${hours}" "${minutes}" "${seconds}"
}

log_modified_at() {
    local log_file_path=""

    log_file_path="$(log_file)"

    if [[ -f "${log_file_path}" ]]; then
        stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "${log_file_path}" 2>/dev/null \
            || stat -c '%y' "${log_file_path}" 2>/dev/null \
            || printf 'n/a'
    else
        printf 'n/a'
    fi
}

open_in_browser() {
    local url

    url="$(server_url)"

    if command -v open >/dev/null 2>&1; then
        open "${url}" >/dev/null 2>&1 || warn "Unable to open ${url} automatically."
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${url}" >/dev/null 2>&1 || warn "Unable to open ${url} automatically."
    else
        warn "No browser opener found. Open ${url} manually."
        return 1
    fi

    success "Opened ${url}"
}

print_status_block() {
    local pid=""
    local url
    local code="000"
    local state_label="STOPPED"
    local state_color="${C_WARN}"
    local uptime="n/a"
    local listener_details

    load_state
    cleanup_stale_state

    pid="$(managed_pid || true)"
    url="$(server_url)"
    code="$(http_status_code "${url}")"
    listener_details="$(listener_details_for_port)"

    if managed_server_running; then
        state_label="HEALTHY"
        state_color="${C_SUCCESS}"
        uptime="$(format_uptime "${STATE_STARTED_EPOCH:-}")"
        if [[ "${code}" != "200" ]]; then
            state_label="DEGRADED"
            state_color="${C_WARN}"
        fi
    elif port_is_in_use; then
        state_label="PORT OCCUPIED"
        state_color="${C_DANGER}"
    fi

    print_header "${CONSOLE_TITLE}"
    print_kv "State" "${state_color}${state_label}${C_RESET}"
    print_kv "URL" "${url}"
    print_kv "PID" "${pid:-n/a}"
    print_kv "HTTP" "${code:-000}"
    print_kv "Uptime" "${uptime}"
    print_kv "Log File" "$(log_file)"
    print_kv "Last Log" "$(log_modified_at)"

    if [[ -n "${listener_details}" ]]; then
        print_line "-"
        printf '  Listener\n'
        printf '  %s\n' "${listener_details}"
    fi
}

start_server() {
    local existing_pid=""
    local command_line=""
    local log_file_path=""
    local pid=""
    local url=""

    require_commands node curl lsof
    ensure_runtime_dir
    cleanup_stale_state

    load_state

    if managed_server_running; then
        existing_pid="$(managed_pid)"
        success "Managed server already running on $(server_url) (PID ${existing_pid})."
        log_event "INFO" "Start requested while server already running (PID ${existing_pid})."
        if (( OPEN_BROWSER > 0 )); then
            open_in_browser
        fi
        return 0
    fi

    if port_is_in_use; then
        error "Port ${PORT} is already in use by a different process."
        listener_details_for_port >&2
        log_event "ERROR" "Refused start because port ${PORT} is occupied by another process."
        return 1
    fi

    url="$(server_url)"
    log_file_path="$(log_file)"
    command_line="LOCAL_APP_DEFAULT_FILE=${LOCAL_APP_DEFAULT_FILE} node --experimental-sqlite ${SERVER_ENTRYPOINT} --host ${HOST} --port ${PORT}"

    log_event "INFO" "Starting server with command: ${command_line}"

    if command -v setsid >/dev/null 2>&1; then
        setsid env LOCAL_APP_DEFAULT_FILE="${LOCAL_APP_DEFAULT_FILE}" \
            node --experimental-sqlite "${SERVER_ENTRYPOINT}" --host "${HOST}" --port "${PORT}" \
            >> "${log_file_path}" 2>&1 < /dev/null &
    else
        nohup env LOCAL_APP_DEFAULT_FILE="${LOCAL_APP_DEFAULT_FILE}" \
            node --experimental-sqlite "${SERVER_ENTRYPOINT}" --host "${HOST}" --port "${PORT}" \
            >> "${log_file_path}" 2>&1 < /dev/null &
    fi
    pid=$!

    persist_state "${pid}" "${command_line}"

    if run_with_spinner "Waiting for ${url}" wait_for_ready "${url}"; then
        log_event "INFO" "Server ready at ${url} (PID ${pid})."
        success "Server started at ${url} (PID ${pid})."
        if (( OPEN_BROWSER > 0 )); then
            open_in_browser
        fi
        return 0
    fi

    error "Server failed readiness checks at ${url}."
    log_event "ERROR" "Server failed readiness checks at ${url}."

    if is_pid_running "${pid}"; then
        kill -TERM "${pid}" 2>/dev/null || true
        wait_for_process_exit "${pid}" 3 || kill -KILL "${pid}" 2>/dev/null || true
    fi

    clear_state
    return 1
}

stop_server() {
    local pid=""

    require_commands lsof
    cleanup_stale_state
    pid="$(managed_pid || true)"

    if [[ -z "${pid}" ]]; then
        warn "No managed server is currently running."
        log_event "INFO" "Stop requested but no managed server was running."
        return 0
    fi

    if ! is_pid_running "${pid}"; then
        warn "Managed PID ${pid} is no longer active. Cleaning runtime metadata."
        log_event "WARN" "Managed PID ${pid} was not active during stop."
        clear_state
        return 0
    fi

    log_event "INFO" "Stopping managed server PID ${pid}."
    kill -TERM "${pid}" 2>/dev/null || true

    if run_with_spinner "Stopping PID ${pid}" wait_for_process_exit "${pid}" 6; then
        clear_state
        log_event "INFO" "Managed server PID ${pid} stopped cleanly."
        success "Server stopped."
        return 0
    fi

    warn "Graceful shutdown timed out. Forcing PID ${pid} to exit."
    kill -KILL "${pid}" 2>/dev/null || true

    if wait_for_process_exit "${pid}" 2; then
        clear_state
        log_event "WARN" "Managed server PID ${pid} required forced shutdown."
        success "Server stopped after forced shutdown."
        return 0
    fi

    error "Unable to stop managed server PID ${pid}."
    log_event "ERROR" "Unable to stop managed server PID ${pid}."
    return 1
}

restart_server() {
    stop_server
    start_server
}

show_status() {
    require_commands curl lsof
    print_status_block
}

show_logs() {
    local log_file_path=""

    ensure_runtime_dir
    log_file_path="$(log_file)"

    if [[ ! -f "${log_file_path}" ]]; then
        warn "No log file exists yet."
        return 0
    fi

    print_header "Recent Server Logs"
    tail -n "${TAIL_LINES}" "${log_file_path}"

    if (( FOLLOW_LOGS > 0 )); then
        print_line "-"
        info "Following ${log_file_path}"
        tail -n "${TAIL_LINES}" -f "${log_file_path}"
    fi
}

show_debug() {
    local pid=""
    local url=""
    local code=""
    local command_line=""
    local log_file_path=""
    local state_file_path=""
    local node_version=""
    local curl_headers=""
    local health_json=""

    require_commands node curl lsof
    load_state
    cleanup_stale_state

    pid="$(managed_pid || true)"
    url="$(server_url)"
    code="$(http_status_code "${url}")"
    log_file_path="$(log_file)"
    state_file_path="$(state_file)"
    command_line="${STATE_SERVER_COMMAND:-}"
    if [[ -z "${command_line}" && -n "${pid}" ]]; then
        command_line="$(pid_command "${pid}")"
    fi
    node_version="$(node --version 2>&1)"
    curl_headers="$(curl -I -sS --max-time 3 "${url}" 2>/dev/null || true)"
    health_json="$(curl -sS --max-time 3 "$(health_url)" 2>/dev/null || true)"

    print_header "${DEBUG_TITLE}"
    print_kv "Root Dir" "${ROOT_DIR}"
    print_kv "Runtime Dir" "${RUNTIME_DIR}"
    print_kv "Host" "${HOST}"
    print_kv "Port" "${PORT}"
    print_kv "URL" "${url}"
    print_kv "PID" "${pid:-n/a}"
    print_kv "HTTP" "${code:-000}"
    print_kv "Started" "${STATE_STARTED_AT:-n/a}"
    print_kv "Node" "${node_version}"
    print_kv "Command" "${command_line:-n/a}"
    print_kv "Target" "${ROOT_DIR}/${TARGET_FILE}"
    print_kv "State File" "${state_file_path}"
    print_kv "Log File" "${log_file_path}"
    print_kv ".env File" "$([[ -f "${ENV_FILE}" ]] && printf '%s' "${ENV_FILE}" || printf 'missing')"

    print_line "-"
    printf '  Port Ownership\n'
    listener_details_for_port | sed 's/^/  /'

    print_line "-"
    printf '  HTTP Probe\n'
    if [[ -n "${curl_headers}" ]]; then
        printf '%s\n' "${curl_headers}" | sed 's/^/  /'
    else
        printf '  No HTTP headers returned.\n'
    fi

    if [[ -f "${log_file_path}" ]]; then
        print_line "-"
        printf '  Log Tail\n'
        tail -n 20 "${log_file_path}" | sed 's/^/  /'
    fi

    if [[ -n "${health_json}" ]]; then
        print_line "-"
        printf '  API Health\n'
        printf '%s\n' "${health_json}" | sed 's/^/  /'
    fi
}

show_menu() {
    local choice=""

    if [[ ! -t 0 ]]; then
        usage
        return 0
    fi

    while true; do
        printf '\033c'
        print_status_block
        print_line "-"
        printf '  Actions\n'
        printf '  1. Start server\n'
        printf '  2. Open page in browser\n'
        printf '  3. Show status\n'
        printf '  4. Tail logs\n'
        printf '  5. Run diagnostics\n'
        printf '  6. Restart server\n'
        printf '  7. Stop server\n'
        printf '  8. Exit\n'
        print_line "-"
        printf '  Select an action [1-8]: '
        read -r choice
        printf '\n'

        case "${choice}" in
            1)
                start_server
                ;;
            2)
                open_in_browser
                ;;
            3)
                show_status
                ;;
            4)
                show_logs
                ;;
            5)
                show_debug
                ;;
            6)
                restart_server
                ;;
            7)
                stop_server
                ;;
            8)
                info "Exiting operator console."
                return 0
                ;;
            *)
                warn "Select a valid action from 1 to 8."
                ;;
        esac

        printf '\n'
        read -r -p '  Press Enter to continue... ' _
    done
}

dispatch() {
    case "${COMMAND}" in
        start)
            resolve_target_file
            start_server
            ;;
        stop)
            stop_server
            ;;
        restart)
            resolve_target_file
            restart_server
            ;;
        status)
            resolve_target_file
            show_status
            ;;
        logs)
            show_logs
            ;;
        debug)
            resolve_target_file
            show_debug
            ;;
        open)
            resolve_target_file
            open_in_browser
            ;;
        menu)
            resolve_target_file
            show_menu
            ;;
        help)
            usage
            ;;
        *)
            fail "Unknown command: ${COMMAND}"
            ;;
    esac
}

parse_args "$@"
init_colors
validate_options
dispatch
