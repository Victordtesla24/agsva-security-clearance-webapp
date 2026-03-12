---
title: feat: Finalize AGSVA production Firebase release
type: feat
status: active
date: 2026-03-13
---

# feat: Finalize AGSVA production Firebase release

Bring the AGSVA Clearance Platform to a production-ready, requirements-aligned release by validating the current implementation against [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md), correcting scope and workflow gaps, proving persistence and export flows end-to-end, publishing the final code to GitHub, and deploying the static production build to Firebase Hosting.

## Research Findings

- The current repo already contains the core runtime pieces required for the platform:
  - [`index.html`](/Users/Shared/antigravity/agsva-security-clearance-webapp/index.html) provides the executive-grade SPA UI.
  - [`app-runtime.js`](/Users/Shared/antigravity/agsva-security-clearance-webapp/app-runtime.js) upgrades persistence to SQLite-backed local-server mode and encrypted Firebase-backed static mode.
  - [`server/local-app.mjs`](/Users/Shared/antigravity/agsva-security-clearance-webapp/server/local-app.mjs) and [`server/persistence.mjs`](/Users/Shared/antigravity/agsva-security-clearance-webapp/server/persistence.mjs) provide local API and SQLite durability.
  - [`scripts/manual-static-firebase-smoke.mjs`](/Users/Shared/antigravity/agsva-security-clearance-webapp/scripts/manual-static-firebase-smoke.mjs) provides headless Firebase/static validation.
- `npm run ci` already passes locally, so the remaining work is a production hardening and requirements-alignment pass rather than a greenfield implementation.
- The main requirements-alignment risk is that `FR-008`, `FR-012`, and `FR-013` are explicitly roadmap-only in [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md), but the current UI/runtime still treats financial and family inputs as active validated workflows and includes them in completion metrics.
- The current document bundle export is still a stub in [`index.html`](/Users/Shared/antigravity/agsva-security-clearance-webapp/index.html) and does not produce a real ZIP artifact, which weakens local export readiness under `FR-014`.
- Firebase Hosting configuration already exists in [`firebase.json`](/Users/Shared/antigravity/agsva-security-clearance-webapp/firebase.json), [`firestore.rules`](/Users/Shared/antigravity/agsva-security-clearance-webapp/firestore.rules), and [`firebase-config.js`](/Users/Shared/antigravity/agsva-security-clearance-webapp/firebase-config.js), so deployment should be a publish/final-verification step rather than a platform migration.
- No project learnings were found in `docs/solutions/`.

## Decisions

- [ ] Treat [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md) as the release authority and align UI, validation, persistence, and exports strictly to the approved scope.
- [ ] Keep the approved production workflows centered on identity, chronology coverage, documents, referee readiness, disclosure support, progress tracking, persistence, and local export artifacts.
- [ ] Remove roadmap-only sections from readiness scoring and blocking validation, and clearly label them as future-scope or advisory-only where they remain visible.
- [ ] Implement a real local ZIP export for uploaded document bundles in the browser so the applicant can produce a deterministic export artifact without manual reconstruction.
- [ ] Preserve the existing durable storage model:
  - SQLite plus file store for local/server mode.
  - Encrypted Firebase Firestore vault for static/Firebase hosting.
  - Browser fallback only as a last-resort degraded mode.
- [ ] Validate the final state with automated repository checks, headless browser smoke coverage, and Firebase/static workflow checks before publishing.
- [ ] Ship from the current `main` branch to `origin/main` and deploy the static artifact to Firebase Hosting.

## Scope

- [ ] Audit the current product against `FR-001` through `FR-014` and the non-functional requirements in [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md).
- [ ] Correct any strict-scope violations where roadmap-only workflows currently behave like approved production requirements.
- [ ] Ensure application completeness and readiness metrics are based only on approved blocking workflows.
- [ ] Implement a real ZIP document export flow for uploaded artifacts.
- [ ] Preserve or improve the current executive-grade referee PDF and application summary PDF outputs.
- [ ] Re-run local/server durability validation and static/Firebase durability validation.
- [ ] Run review and browser validation on the current branch, then resolve any resulting todos.
- [ ] Commit all final changes to git, push to GitHub, and deploy the Firebase Hosting build.

## Risks

- Requirements strictness matters here: leaving roadmap-only workflows in the blocking readiness path would make the platform non-compliant with its own governing requirements document.
- Static Firebase Hosting cannot run the local Node.js server, so the production path must continue to rely on encrypted Firebase persistence rather than SQLite-backed APIs.
- Export changes must work across both server and Firebase storage modes because uploaded document content is sourced differently in each mode.
- PDF and ZIP export flows can regress silently if browser-only code paths are not exercised in automated smoke coverage.

## Acceptance Criteria

- [ ] The production readiness score and submission checklist are driven only by approved active-scope requirements from [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md).
- [ ] Roadmap-only workflows (`FR-008`, `FR-012`, `FR-013`) do not block completion and are not presented as required production gates.
- [ ] The platform generates a real ZIP archive for uploaded supporting documents in local export mode.
- [ ] Personal data, chronology data, referee records, and uploaded-document metadata persist correctly across refreshes in both local/server mode and Firebase/static mode.
- [ ] Referee briefing PDF export and application summary PDF export both succeed without layout overlap or runtime errors.
- [ ] `npm run ci` passes.
- [ ] Headless browser validation passes for the current branch.
- [ ] Static Firebase smoke validation passes against the generated build.
- [ ] All review todos are resolved or explicitly closed with justification.
- [ ] Final changes are committed and pushed to `https://github.com/Victordtesla24/agsva-security-clearance-webapp.git`.
- [ ] Firebase Hosting deploy completes successfully and serves the final release.

## Implementation Checklist

- [ ] Create a strict requirements-to-implementation gap list from [`docs/requirements.md`](/Users/Shared/antigravity/agsva-security-clearance-webapp/docs/requirements.md).
- [ ] Refactor readiness scoring and checklist logic to exclude roadmap-only workflows from production gating.
- [ ] Adjust UI copy or presentation for roadmap-only sections so the active production scope is unambiguous.
- [ ] Implement browser-side ZIP export for uploaded documents across server and Firebase persistence modes.
- [ ] Extend or update automated browser smoke coverage if needed for the ZIP export and refined readiness behavior.
- [ ] Run local review, browser validation, CI, and Firebase/static smoke checks.
- [ ] Resolve review todos.
- [ ] Commit, push, deploy, and verify the live Firebase release.

## Post-Deploy Monitoring & Validation

- Log searches:
  - `Failed to persist application state`
  - `Cloud persistence unavailable`
  - `Referee PDF generation failed`
  - `Unhandled request failure`
- Healthy signals:
  - The production app reports `Firebase encrypted vault active` when opened on Firebase Hosting.
  - A saved form survives reload and rehydrates previously uploaded document metadata.
  - Referee PDF, application PDF, and document ZIP exports complete without browser console errors.
  - The submission checklist reaches completion without requiring roadmap-only sections.
- Failure signals:
  - The app falls back to browser storage on the live Firebase site without an operator-intended reason.
  - ZIP or PDF exports fail or download empty artifacts.
  - Completion percentage remains blocked by financial, family, or clearance-history sections.
  - Browser console errors appear during hydration, autosave, upload, or export flows.
- Validation window:
  - Immediate post-deploy verification on March 13, 2026
- Owner:
  - Repository operator
