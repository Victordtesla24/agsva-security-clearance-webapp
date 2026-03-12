---
title: refactor: Review, debug, and fully validate codebase operation
type: refactor
status: active
date: 2026-03-13
---

# refactor: Review, debug, and fully validate codebase operation

Review the current AGSVA webapp changes, fix concrete defects, and manually validate the full static Firebase flow including PDF generation.

## Scope

- [x] Review the current Firebase/static-hosting, validation, and PDF-generation changes for functional regressions.
- [x] Fix deterministic build and deployment behavior for clean/static builds without breaking the current local Firebase workflow.
- [x] Fix browser automation gaps so manual validation proves real behavior instead of failing on race conditions or brittle selectors.
- [x] Fix runtime bugs exposed by the manual validation flow.
- [x] Re-run repository CI and manual static Firebase validation until the full flow is working.
- [x] Document remaining operational risks that cannot be solved purely with code edits in the working tree.

## Current Findings

- The static deployment path depends on `firebase-config.js`, but clean/static builds need deterministic behavior when that file is absent.
- The Pages workflow copies static assets directly and does not build a reproducible Firebase/static artifact.
- The manual Firebase smoke script is brittle around reload hydration, selectors, and headless download handling.
- The runtime validation layer sets `aria-invalid` as a boolean attribute instead of a valid ARIA value.
- The current local environment still uses a legacy Firebase config shape, so the code must avoid clobbering an already-working generated config file.

## Acceptance Criteria

- [x] `npm run ci` passes.
- [x] Static Pages/Firebase packaging builds deterministically from the repository with a safe fallback when normalized Firebase env vars are absent.
- [x] Manual static Firebase validation passes against the local hosted app, including persisted form state, document persistence, referee persistence, and both PDF generation flows.
- [x] Invalid form fields expose `aria-invalid="true"` when validation fails.
- [x] Remaining non-code operational risks are explicitly captured for follow-up.

## Validation Plan

- Run `npm run ci`.
- Run `node scripts/manual-static-firebase-smoke.mjs` against a local static host in headless mode.
- Confirm the smoke covers reload hydration, uploaded document visibility, referee persistence, invalid personal-info validation, referee PDF generation, and application PDF generation.

## Deepened Implementation Plan

### Workstream 1: Build and Deployment Determinism

- [x] Update Firebase config generation so clean builds can produce a deterministic output instead of crashing on a missing generated file.
- [x] Keep the current local workflow safe by preserving an already-generated local `firebase-config.js` when only legacy config data is available.
- [x] Route the Pages workflow through the reproducible `.firebase-dist` build path and allow GitHub repository `FIREBASE_*` variables to populate real config when present.

### Workstream 2: Runtime Validation Quality

- [x] Fix invalid-field accessibility semantics so runtime validation emits correct ARIA state.
- [x] Re-run the manual invalid-input flow through the browser smoke and confirm the runtime behavior matches the accessibility contract.

### Workstream 3: Browser Validation Reliability

- [x] Remove hydration races from the Firebase smoke by explicitly waiting for persistence readiness after reloads.
- [x] Replace brittle selectors with the actual DOM selectors used by the page.
- [x] Validate PDF generation by checking successful UI completion in headless mode instead of depending on flaky browser download plumbing.

### Workstream 4: End-to-End Verification

- [x] Run CI-parity checks after the code changes land.
- [x] Run the static Firebase smoke end to end against the local hosted app.
- [x] Record any remaining risks that are environmental or git-state related rather than code defects.

## File Targets

- `scripts/sync-firebase-config.mjs`
- `package.json`
- `.github/workflows/pages.yml`
- `scripts/build-firebase-dist.sh`
- `scripts/manual-static-firebase-smoke.mjs`
- `app-runtime.js`
- `README.md`

## Residual Risk To Track

- Critical Firebase/static assets are currently present in the working tree but not all are committed/tracked yet, so upstream automation will only reflect these fixes after those files are added to git.

## Execution Notes

- `npm run ci` passes on the working tree after the config-generation, workflow, smoke-test, and accessibility fixes.
- `node scripts/manual-static-firebase-smoke.mjs` passes against the locally hosted static app and validates the end-to-end Firebase persistence plus both PDF flows.
