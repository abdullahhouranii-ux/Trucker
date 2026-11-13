# Foundation slice 1: workspace, pinned tooling, configuration, health and readiness, migration checks

Date: 13 November 2026. Status: **on a review branch; not merged to main, not deployed.**

## Scope

| In this slice | Not in this slice |
|---|---|
| npm workspace with one application, `apps/api` | Any business module, table or endpoint (all gated: docs/specs/STAGE_3_ARCHITECTURE.md, section 11) |
| Pinned runtime and tool versions, committed lockfile | Web, console and driver applications |
| Validated configuration that refuses to start when wrong | Error envelope and request identifier (remainder of F-03) |
| `GET /health/live` and `GET /health/ready` | Audit log, outbox, idempotency store, row-level security (F-07 to F-10) |
| Forward-only SQL migration runner with checks; one baseline migration with no business tables | Countries, currencies and other reference data (wait for D-003) |
| CI workflow file | A run of that workflow on GitHub |

## Pinned versions

Chosen from the npm registry on 13 November 2026 and fixed exactly in `package.json` and `package-lock.json`.

| Tool | Version | Note |
|---|---|---|
| Node.js | 22 (`.nvmrc`; engines `>=22.12 <23`) | Evidence below ran on 22.23.4 |
| npm | 10.9.9 | `engine-strict` is on |
| TypeScript | 6.0.3 | Not 7.x: typescript-eslint 8.72.2 declares support below 6.1 |
| NestJS (`common`, `core`, `platform-express`) | 12.5.0 | Published as ES modules, so the API is an ES-module project |
| pg | 8.23.1 | |
| zod | 4.6.7 | Configuration validation only |
| ESLint / typescript-eslint / Prettier | 10.14.0 / 8.72.2 / 3.10.1 | |
| PostgreSQL | 16 | Evidence ran on 16.15. Moving to a newer major needs the checks re-run |

Tests use Node's built-in test runner on the compiled output, so there is no separate test framework to pin.

## How to run

```
npm ci
cp .env.example .env            # local values only
docker compose -f tools/dev/docker-compose.yml up -d   # not executed in the authoring session
export NODE_ENV=test DATABASE_URL=postgres://trucker:trucker-local-only@localhost:5432/trucker_dev
npm run verify                  # format check, lint, type check, migration file check, tests
npm run db:migrate && npm run db:status
npm run start:api
```

The database role used for tests must be allowed to create databases: each test file creates and drops its own.

## Acceptance evidence

All of the following was executed on 13 November 2026 against a locally installed PostgreSQL 16.15, on a copy of the files containing nothing but what is tracked (no `node_modules`, no build output).

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | A clean copy installs from the lockfile | `npm ci`: "added 209 packages" | Pass |
| 2 | Formatting, lint and type check pass | `npm run verify`: "All matched files use Prettier code style!"; ESLint no findings; `tsc --noEmit` exit 0 | Pass |
| 3 | A type error fails the check | A file with a wrong type added temporarily: `npm run typecheck` exit 2 | Pass |
| 4 | Missing or malformed configuration stops the process | Start with no `NODE_ENV`, no `DATABASE_URL`, `PORT=abc`: three problems listed by key, exit 1 | Pass |
| 5 | Configuration errors never echo a value | Unit test "never echoes a configured value in the error" | Pass |
| 6 | Migration files are validated without a database | `npm run db:check`: "migration files valid: 1"; with a numbering gap added temporarily the command fails | Pass |
| 7 | Migrations apply to an empty database | `migrate status`: "applied: 0, pending: 1" exit 1; `migrate up`: "applied: 1" exit 0 | Pass |
| 8 | A second run applies nothing | `migrate up`: "applied: none"; `migrate status`: "applied: 1, pending: 0, problems: 0" exit 0 | Pass |
| 9 | An applied migration that is later edited is detected and blocks further runs | Integration test | Pass |
| 10 | A failing migration is rolled back completely and later ones are not applied | Integration test | Pass |
| 11 | Two runners started together apply each migration once | Integration test (advisory lock) | Pass |
| 12 | Liveness does not depend on the database | Running process, database stopped: `/health/live` 200 | Pass |
| 13 | Readiness is false when the database is unreachable and recovers when it returns | Running process: 200 `ready`; database stopped: 503 `{"database":"unavailable","migrations":"unknown"}`; database started: 200 again without restarting the API | Pass |
| 14 | Readiness is false while migrations are pending | Integration test: 503 `{"database":"ok","migrations":"pending"}` | Pass |
| 15 | Readiness responses leak no connection detail | Integration test asserts the body contains only the two check names | Pass |
| 16 | Whole suite | 17 tests, 17 pass, 0 fail | Pass |

## Not verified

- `tools/dev/docker-compose.yml` was not executed: no Docker daemon was available.
- `.github/workflows/ci.yml` has not run: nothing has been pushed. The versions of the two GitHub actions it uses should be confirmed on the first run.
- Only Linux was used. Windows and macOS setup is untested.
- No load, security or dependency-vulnerability review was done.

## Choices in this slice that need confirmation

| Choice | Why | Alternative |
|---|---|---|
| A small in-repository migration runner (about 150 lines) instead of a library | It gives exactly the required checks: contiguous numbering, checksum of applied files, one transaction per file, single runner | An established migration library; less code to own, but the edited-after-apply check would need adding |
| Readiness treats pending migrations as "not ready" | A build must not serve traffic against a schema it does not match | Report only database reachability |
| Tests run on compiled output with Node's test runner | NestJS 12 is ES-module only; this avoids a test framework and its transform configuration | A test framework with TypeScript transform |
| PostgreSQL 16 | It is what the evidence ran on | A newer major, after re-running the checks |
