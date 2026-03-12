---
status: pending
priority: p1
issue_id: "001"
tags: [firebase, deployment, git, operations]
dependencies: []
---

# Track Firebase rollout files in git

## Problem Statement

The Firebase/static-hosting rollout now works in the local working tree, but several critical files are still untracked. Remote CI, Pages, and Firebase deployment workflows will not inherit the working configuration until those files are added to git.

## Findings

- The validated local workflow depends on generated/static-hosting assets and scripts that are present in the working tree but still appear as untracked in `git status`.
- This includes the Firebase/static build scripts, Firebase hosting files, generated config, and the manual browser smoke test fixture path used for validation.
- The application is locally usable now, but upstream automation will remain incomplete until the required files are actually added to version control.

## Proposed Solutions

### Option 1: Add the rollout files to git

- Pros: Remote CI and deployment workflows match the verified local state.
- Cons: Requires deliberate review of which generated files should be versioned versus regenerated in CI.
- Effort: Small
- Risk: Low

### Option 2: Move all required artifacts behind tracked generators only

- Pros: Keeps the repo cleaner and avoids tracking generated files.
- Cons: Requires another pass to ensure every deployment-critical artifact can be reconstructed from tracked code plus environment variables.
- Effort: Medium
- Risk: Medium

## Recommended Action

Review the untracked Firebase/static-hosting files, add the required source files and fixtures to git, and keep only truly generated/local artifacts untracked.

## Acceptance Criteria

- [ ] All files required for the verified Firebase/static workflow are tracked in git.
- [ ] `git status --short` no longer shows critical rollout scripts or hosting files as untracked.
- [ ] Remote CI/Pages can reproduce the same workflow without depending on local-only files.

## Work Log

### 2026-03-13 - Review synthesis

**By:** Codex

**Actions:**
- Completed local code review, bug fixing, and validation for the Firebase/static workflow.
- Verified `npm run ci` and `node scripts/manual-static-firebase-smoke.mjs` succeed locally.
- Recorded the remaining git-state risk as a follow-up todo because it cannot be resolved purely by code edits without deciding what should be versioned.

**Learnings:**
- The local workflow is operational, but deployment parity still depends on versioning the correct Firebase rollout files.
