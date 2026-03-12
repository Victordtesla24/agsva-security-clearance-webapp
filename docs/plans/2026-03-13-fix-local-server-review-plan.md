---
title: fix: Harden local server and operator scripts
type: fix
status: active
date: 2026-03-13
---

# fix: Harden local server and operator scripts

Review the codebase and fix concrete defects everywhere except `index.html`.

## Scope

- [x] Preserve `index.html` unchanged.
- [x] Fix the local Node server so it does not expose private repository files such as dotfiles or runtime artifacts.
- [x] Fix default-document selection so the server and operator scripts work in this repository without a `draft.html`.
- [x] Fix malformed-path handling so invalid encoded URLs return a deterministic client error instead of a server error.
- [x] Re-run syntax and smoke validation for the patched scripts and server.
- [x] Run a final review pass for remaining non-HTML issues and resolve anything found.

## Findings

- The default server configuration targets `draft.html`, but this repository only ships `index.html`, so `/` returns `404` unless an override is set.
- The static file resolver currently serves arbitrary files from the repository root, including `.env`.
- Invalid percent-encoded paths such as `/%ZZ` currently trigger a `500` response instead of a client error.
- The operator script readiness/open URLs depend on `TARGET_FILE`, so the shell layer must resolve the same effective document as the Node server.

## Acceptance Criteria

- [x] Starting the local server without overrides serves a valid HTML document at `/`.
- [x] Requests for `/.env`, dotfiles, `scripts/*`, `server/*`, `docs/*`, and `artifacts/*` do not return file contents.
- [x] Requests with malformed encoded paths return `400`.
- [x] `node --check` and `bash -n` pass for the modified files.

## Validation Notes

- `scripts/test-local-app.sh` passes and covers `/`, `/api/health`, blocked private paths, and malformed URLs.
- `scripts/serve-draft.sh start|status|stop` now resolves `index.html` automatically in this repository and starts cleanly.
- A headless `agent-browser` smoke pass loads the page successfully, reports the expected title, and shows no page errors.
