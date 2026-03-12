---
title: feat: Ship durable AGSVA storage, validation, and executive PDF exports
type: feat
status: active
date: 2026-03-13
---

# feat: Ship durable AGSVA storage, validation, and executive PDF exports

Upgrade the AGSVA clearance webapp so it validates user-entered information accurately, persists application data across refreshes and sessions using a real database, generates overflow-safe executive-grade PDFs, passes review, and is shipped to production.

## Research Findings

- `index.html` currently keeps most state in `sessionStorage`, which is erased on tab/session loss and does not satisfy durable persistence.
- Uploaded document blobs are stored in browser IndexedDB only, which is device-local and unsuitable as the system of record.
- The current custom Node server in [`server/local-app.mjs`](/Users/Shared/antigravity/agsva-security-clearance-webapp/server/local-app.mjs) exposes no CRUD endpoints for application data or file uploads.
- The current PDF generators in [`index.html`](/Users/Shared/antigravity/agsva-security-clearance-webapp/index.html) rely on fixed coordinates and manual page breaks, which is the direct cause of overflow and overlap defects.
- The repository already targets GitHub publication on `main`, has CI workflows, and can support GitHub Pages deployment from static assets or a deployment workflow.
- No reusable institutional learnings were found in `docs/solutions/`.

## Decisions

- [ ] Use SQLite on the Node server as the authoritative database for application state, referee records, and document metadata.
- [ ] Persist uploaded files on the server filesystem under a dedicated data directory excluded from git, with database records pointing to stored artifacts.
- [ ] Keep the client responsive by autosaving to the server with debounced writes and hydrating state from the server on load.
- [ ] Replace ad hoc field checks with schema-driven validation rules that cover requiredness, chronology, formatting, and AGSVA-specific referee constraints.
- [ ] Replace fixed-layout PDF composition with reusable layout primitives that measure text, add pages automatically, and render consistent headers, sections, tables, and callouts.
- [ ] Deploy the production website through GitHub Pages backed by the committed static site, while documenting that server-backed durability requires the local/server runtime unless a managed host with Node support is provisioned.

## Scope

- [ ] Add a server-side persistence layer in [`server/local-app.mjs`](/Users/Shared/antigravity/agsva-security-clearance-webapp/server/local-app.mjs) with SQLite initialization, migrations, and JSON/file CRUD endpoints.
- [ ] Add local project dependencies and scripts required for SQLite-backed operation and validation.
- [ ] Refactor [`index.html`](/Users/Shared/antigravity/agsva-security-clearance-webapp/index.html) to load and save application state through the server instead of `sessionStorage`.
- [ ] Preserve upload functionality while moving the durable copy of files to the server and keeping previews/export metadata accurate after refresh.
- [ ] Add deterministic validation for personal info, employment, address coverage, referee data, and disclosure text.
- [ ] Refactor referee and application PDF generation so page flow is automatic and presentation quality is consistent.
- [ ] Review and debug changed code paths, then resolve review findings.
- [ ] Run repository validation and browser validation against the upgraded app.
- [ ] Commit and push the final result to `origin/main`.
- [ ] Deploy the production site through GitHub Pages with the required workflow/configuration.

## Risks

- SQLite support must be added in a way that keeps local startup simple and CI deterministic.
- GitHub Pages can host the static site but cannot run the Node persistence layer; production deployment therefore needs a split between static publication and documented server/runtime requirements unless another authenticated free host is available.
- Existing in-browser data may need a one-time migration path into server-backed storage to avoid silent data loss.
- Large uploads can exceed GitHub Pages hosting expectations, so the persistence path must avoid shipping runtime data in the built site.

## Acceptance Criteria

- [ ] Refreshing the page does not erase saved form data, referee data, or uploaded-document metadata when running through the local/server runtime.
- [ ] The app hydrates previously saved server-backed state on load with no manual recovery steps.
- [ ] Validation messages correspond to the actual fields and AGSVA rules in the form instead of generic or stale checks.
- [ ] Referee briefing PDFs and application summary PDFs render without text overlap or cutoff for realistic long-form content.
- [ ] `npm run ci` passes after the refactor.
- [ ] Browser smoke validation confirms the main flows still work.
- [ ] Changes are committed and pushed to `https://github.com/Victordtesla24/agsva-security-clearance-webapp.git`.
- [ ] GitHub Pages deployment assets/workflow are present and production publishing is triggered from the repository.

## Implementation Checklist

- [ ] Add dependencies and storage directories for SQLite-backed persistence.
- [ ] Build server endpoints for loading/saving app state and managing uploads.
- [ ] Migrate client autosave and restore logic to the server API.
- [ ] Harden form validation and wire UI feedback to the validation results.
- [ ] Rebuild PDF layout with reusable pagination helpers.
- [ ] Run code review and browser validation, then fix findings.
- [ ] Commit, push, and deploy.

## Post-Deploy Monitoring & Validation

- Log searches:
  - `Local AGSVA server ready`
  - `Unhandled request failure`
  - `AI validation failed`
- Healthy signals:
  - `GET /api/health` returns `ok: true`
  - Saved state reloads correctly after browser refresh
  - PDF exports complete with expected page counts and no layout defects
- Failure signals:
  - `5xx` responses from state or upload endpoints
  - Missing hydrated data after refresh
  - Browser console errors during upload or export flows
- Validation window:
  - Immediate manual verification after deploy and after the first push to `main`
- Owner:
  - Repository operator
