# AGSVA Clearance Platform

[![CI](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/ci.yml)
[![Repository Hygiene](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/repo-hygiene.yml/badge.svg?branch=main)](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/repo-hygiene.yml)
[![CodeQL](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Victordtesla24/agsva-security-clearance-webapp/actions/workflows/codeql.yml)

AGSVA Clearance Platform is a local-first executive web application for preparing, validating, and presenting a Baseline security clearance submission package with a controlled operating model. The repository combines a polished browser experience in `index.html`, an override runtime layer in `app-runtime.js`, a lightweight Node.js review server, SQLite-backed local persistence, guarded local validation endpoints, and publication-ready engineering controls for GitHub delivery.

## Executive Summary

This project is structured for controlled local operation rather than direct public submission to any government system. It supports readiness tracking, document organization, disclosure drafting support, and referee preparation while keeping the working experience self-contained and auditable.

Primary outcomes:

- Deliver a high-fidelity AGSVA readiness interface with `index.html` as the main application surface.
- Provide a local review server for static delivery, health checks, browser diagnostics, and guarded AI validation.
- Keep operational risk low through repository hygiene controls, secret exclusion, and CI-enforced validation.

## Platform Capabilities

- Executive-grade single-page interface for AGSVA preparation and progress tracking.
- Durable application-state persistence through SQLite when running the local server, with browser fallback on static hosting.
- Server-backed document storage and metadata persistence during local/runtime operation.
- Local Node.js server for serving the application and exposing review-focused endpoints:
  - `GET /api/health`
  - `GET /api/app-state`
  - `PUT /api/app-state`
  - `POST /api/documents`
  - `GET /api/documents/:id/content`
  - `DELETE /api/documents/:id`
  - `POST /api/logs/client`
  - `POST /api/ai/validate`
- Local smoke-test harness to confirm the server, routing, and guardrails remain healthy.
- GitHub Actions workflows for validation, repository hygiene, and CodeQL scanning.

## Architecture

### Application Surface

- [`index.html`](./index.html): primary application experience and client-side workflow logic.
- [`app-runtime.js`](./app-runtime.js): runtime overrides for durable persistence, validation, and PDF overflow control.
- [`server/local-app.mjs`](./server/local-app.mjs): local delivery and validation server.
- [`server/persistence.mjs`](./server/persistence.mjs): SQLite and document-storage layer.
- [`scripts/serve-draft.sh`](./scripts/serve-draft.sh): managed localhost operator console.
- [`scripts/serve-index.sh`](./scripts/serve-index.sh): convenience entrypoint for the published application file.

### Security and Data Handling

- The repo is designed to keep real secrets out of version control.
- Static serving is restricted to intended public files; dotfiles and operational directories are blocked.
- Local AI validation remains opt-in through environment configuration.
- Runtime artifacts are excluded from source control by default.

## Repository Structure

```text
.
├── .github/workflows/        GitHub Actions pipelines
├── docs/                     Requirements and implementation plans
├── index.html                Main AGSVA Clearance Platform interface
├── scripts/                  Local operations, smoke tests, and repo checks
├── server/                   Local Node.js application server
├── .env.example              Safe environment template
└── package.json              Local validation command surface
```

## Local Development

### Prerequisites

- Node.js 22 or newer
- Bash
- `curl`
- `lsof`

### Environment Setup

Create a local `.env` from the example file and provide a real OpenAI API key only if AI validation is required.

```bash
cp .env.example .env
```

### Start the Platform

Run the managed server against the application entrypoint:

```bash
scripts/serve-index.sh start --open
```

Useful operational commands:

```bash
scripts/serve-index.sh status
scripts/serve-index.sh logs --follow
scripts/serve-index.sh debug
scripts/serve-index.sh stop
```

## Validation

The repository exposes a single CI-parity command:

```bash
npm run ci
```

That command executes:

- tracked-file hygiene validation
- Node.js syntax verification
- shell script syntax verification
- end-to-end local smoke testing through the server harness

Individual commands:

```bash
npm run check:repo
npm run check:server
npm run check:shell
npm run test:smoke
```

## Continuous Integration

The GitHub repository includes these automation gates:

- `CI`: runs the full repository validation command on every push to `main` and every pull request.
- `Repository Hygiene`: ensures secrets, runtime artifacts, and operating-system noise are not tracked.
- `CodeQL`: performs JavaScript security and quality analysis on a scheduled cadence and on change events.
- `Pages`: publishes the static browser build to GitHub Pages from `main`.

## Storage Modes

- Local/server runtime: `index.html` calls the same-origin API exposed by `server/local-app.mjs`, which persists application state in SQLite under `data/` and stores document binaries on disk.
- Static hosting: the GitHub Pages deployment serves `index.html` plus `app-runtime.js` only. In that environment the app falls back to browser-managed persistence because there is no server runtime.

## Operational Guidance

- Treat `.env` as local-only and never commit live credentials.
- Use `.env.example` as the contract for supported configuration.
- Review `docs/plans/` for implementation history and validation context.
- Use `scripts/test-local-app.sh` before pushing meaningful changes.
- Follow [`SECURITY.md`](./SECURITY.md) for vulnerability reporting and repo control requirements.

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
