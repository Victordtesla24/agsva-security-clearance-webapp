# AGENTS.md

## Cursor Cloud specific instructions

This repository is a single product: the **AGSVA Clearance Platform**, a local-first
single-page web app (`index.html` + `app-runtime.js`) served by a small Node.js review
server (`server/local-app.mjs`) with embedded SQLite persistence (`server/persistence.mjs`).
There is one service to run. Standard commands live in `README.md` and `package.json`
`scripts` — prefer those instead of duplicating them.

### Node version gotcha (important)
The app relies on Node's `node:sqlite`. The platform default `node` on PATH is the
`/exec-daemon/node` shim (v22.14.0), whose `node:sqlite` **finalizes prepared statements
once the `DatabaseSync` is garbage-collected** — after a few seconds of server idle every
DB call fails with `statement has been finalized` (HTTP 500). The repo's own smoke test
(`npm run test:smoke`) does not catch this because it runs in under a second.

Fix: use the nvm-managed Node 22.x LTS (v22.22.2), which retains the database reference and
does not exhibit the bug (and still satisfies `engines.node: ">=22"`). `~/.bashrc` has been
configured to prepend `~/.nvm/versions/node/v22.22.2/bin` to `PATH` so `node`/`npm` resolve
to the fixed build in interactive/login shells. Verify with `node --version` (expect
`v22.22.2`, not `v22.14.0`). If a fresh VM ever resolves `node` to v22.14.0, run the server
with the nvm node explicitly:
`~/.nvm/versions/node/v22.22.2/bin/node --experimental-sqlite server/local-app.mjs`.

### Running the service (development)
- Managed console: `scripts/serve-index.sh start` (subcommands: `status`, `logs --follow`,
  `debug`, `stop`). See `README.md` "Start the Platform".
- Direct (what the smoke test uses), requires the experimental flag:
  `node --experimental-sqlite server/local-app.mjs --host 127.0.0.1 --port 3000`
- Default URL: http://127.0.0.1:3000/ . Endpoints under `/api/*` (health, app-state,
  documents, ai/validate) are listed in `README.md`.

### Lint / test / build
Use the `package.json` scripts: `npm run ci` (full gate = `check:repo` + `check:server` +
`check:shell` + `test:smoke`). There is no ESLint; "lint" here is `node --check` syntax
verification plus shell `bash -n` checks. No build step is needed for local dev (static
files run as-is); `npm run build:firebase-*` is only for static/Firebase hosting.

### Persistence & runtime artifacts
- SQLite DB and uploads auto-create under `data/` (`data/agsva-app.sqlite`,
  `data/uploads/`); server request/diagnostic logs write under `artifacts/server/`. Both
  `data/` and `artifacts/` are gitignored — do not commit them.
- The Personal Information form (and other sections) persist via `PUT /api/app-state`. On
  page reload the form first renders hardcoded placeholder values, then asynchronously
  repopulates from the server (`hydrateFromServer`) after ~1-2s — wait before reading form
  values in UI tests, otherwise you will see the pre-hydration defaults.

### Optional integrations (not required for local end-to-end)
- OpenAI (`POST /api/ai/validate`) needs `OPENAI_API_KEY`; without it the endpoint returns
  503 and the rest of the app is unaffected.
- Firebase/Firestore is only for the static-hosting deployment mode.
- Copy `.env.example` to `.env` only if you need those integrations.
