# Security Policy

## Supported Scope

This repository contains a local-first application for AGSVA clearance preparation workflows. The codebase is intended for controlled development and review environments, with optional OpenAI-backed validation enabled only through local environment configuration.

Supported security scope includes:

- repository code and GitHub Actions workflows
- local Node.js delivery and validation endpoints
- tracked scripts used for repository operations and smoke testing

Unsupported scope includes:

- secrets stored outside version control
- local workstation compromise
- any third-party infrastructure not managed by this repository

## Reporting a Vulnerability

Report suspected vulnerabilities privately. Do not open a public GitHub issue for live security findings involving secrets, local environment files, or user data.

Recommended disclosure format:

1. affected component or file path
2. severity and realistic impact
3. reproduction steps
4. suggested remediation
5. whether credential rotation is required

## Secret Handling Requirements

- Never commit `.env` or other live credential files.
- Use `.env.example` as the only committed environment contract.
- Treat generated runtime artifacts under `artifacts/` as local-only.
- Rotate credentials immediately if a secret is exposed outside the workstation boundary.

## Repository Controls

The repository includes the following guardrails:

- `.gitignore` excludes secrets and runtime artifacts.
- `scripts/check-repo-hygiene.sh` blocks tracked `.env`, `artifacts/`, and `.DS_Store` files.
- GitHub Actions validate repository health and run CodeQL analysis on the main branch.

## Secure Development Expectations

- Run `npm run ci` before pushing material changes.
- Keep the local review server scoped to intended public files only.
- Avoid adding third-party dependencies unless there is a clear operational need.
- Prefer deterministic, auditable scripts over ad hoc manual steps.
