# Foundation slice 1: workspace, pinned tooling, configuration, health and readiness, migration checks

Date: 13 November 2026, revised the same day after review. Status: **slice 1 was merged into `staging` through pull request 1 (not in `main`, not deployed). The review fixes in section "Review fixes" are on a separate review branch with their own pull request against `staging`.**

## Scope

| In this slice | Not in this slice |
|---|---|
| npm workspace with one application, `apps/api` | Any business module, table or endpoint (all gated: docs/specs/STAGE_3_ARCHITECTURE.md, section 11) |
| Pinned runtime and tool versions, committed lockfile | Web, console and driver applications |
| Validated configuration that refuses to start when wrong | Error envelope and request identifier (remainder of F-03) |
| `GET /health/live` and `GET /health/ready` | Audit log, outbox, idempotency store, row-level security (F-07 to F-10) |
| Forward-only SQL migration runner with checks; one baseline migration with no business tables | Countries, currencies and other reference data (wait for D-003) |
| CI workflow file | A run of that workflow on GitHub |

## Versions: what is pinned exactly and what is a major-version selection

Chosen from the npm registry on 13 November 2026.

**Pinned to an exact release** (in `package.json` and `package-lock.json`; `npm ci` installs exactly these):

| Package | Version | Note |
|---|---|---|
| TypeScript | 6.0.3 | Not 7.x: typescript-eslint 8.72.2 declares support below 6.1 |
| NestJS (`common`, `core`, `platform-express`) | 12.5.0 | Published as ES modules, so the API is an ES-module project |
| pg | 8.23.1 | |
| zod | 4.6.7 | Configuration validation only |
| ESLint / typescript-eslint / Prettier | 10.14.0 / 8.72.2 / 3.10.1 | |

**Major-version selections, not exact pins:**

| Runtime | Selection | What actually ran |
|---|---|---|
| Node.js | Major 22: `.nvmrc` contains `22`; `engines` allows `>=22.12.0 <23`. The newest 22.x available is used | 22.23.4 locally |
| npm | `>=10.9.0 <11` | 10.9.9 locally |
| PostgreSQL | Major 16: the `postgres:16` image tag in the compose file and CI follows the newest 16.x | 16.15 locally |

Decision (Abdullah, 13 Nov 2026): keep Node 22 and PostgreSQL 16 as major-version selections for now, and record the exact versions used in each verification run.

### Exact versions used in each verification run

`npm run versions` prints them; CI runs it as the step "Record runtime versions", so every CI run records its own.

| Run | Node.js | npm | PostgreSQL | Platform |
|---|---|---|---|---|
| Local, slice 1 as first delivered (17 tests) | 22.23.4 | 10.9.9 | 16.15 | Linux x64 |
| Local, review fixes (28 tests, then 34 after the second review) | 22.23.4 | 10.9.9 | 16.15 | Linux x64 |
| GitHub CI, pull request 1 (commits `0899c08`, `a627ae3`) | not recorded: the versions step did not exist yet | | | ubuntu-latest |
| GitHub CI, review-fixes pull request | recorded in that run's "Record runtime versions" step and in the pull request | | | ubuntu-latest |

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

Windows: see `docs/delivery/WINDOWS_SETUP.md` (not yet executed on Windows).

**Migrations run separately, before the API serves traffic.** The API never applies migrations itself. `/health/ready` answers 503 while any migration is pending or inconsistent, so a deployment must run `db:migrate` first and route traffic only when readiness is 200. `/health/live` is independent of the database.

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
| 16 | Whole suite as first delivered | 17 tests, 17 pass, 0 fail (28 after the review fixes below) | Pass |

## Review fixes (13 November 2026, after Abdullah's review of the patch)

On branch `foundation/review-fixes-slice-1`, for review against `staging`. Re-run locally against PostgreSQL 16.15: format, lint, type check, migration file check, and the full suite. After the first review: 28 tests. After the second review (P1, P2): 34 tests, 34 pass, repeated three times.

| # | Finding | Change | Evidence | Result |
|---|---|---|---|---|
| R1 | Migration checksums could differ between Windows and Linux checkouts | `.gitattributes` forces LF for SQL (and normalises text generally). Independently, the runner hashes and executes normalised text: no byte-order mark, LF only | Unit test: LF, CRLF, CR and BOM variants give one checksum. Integration test: a file applied with LF and then rewritten with CRLF is not reported as edited. Simulated checkouts with `core.autocrlf=true`: with `.gitattributes` the file is LF; without it the file is CRLF (8 CR lines) and the checksum is still identical | Pass |
| R2 | Readiness had no execution deadline | One overall deadline for the readiness check (`HEALTH_CHECK_TIMEOUT_MS`, default 2 s); a server-side `statement_timeout` and a driver `query_timeout` on the API pool (`DB_STATEMENT_TIMEOUT_MS`, default 5 s), separate from the connection timeout | Stalled query on an open connection (table lock held): 503 `{"database":"ok","migrations":"unknown"}` inside the deadline, liveness 200, and 200 again after release. Server that accepts connections and never answers: 503 inside the deadline. Query that never resolves (stub): answer inside the deadline | Pass |
| R3 | Migration lock waiting must be bounded separately | Waiting for another runner is bounded (`MIGRATION_LOCK_WAIT_MS`, default 30 s). Waiting for a table lock inside a migration is bounded (`MIGRATION_STATEMENT_LOCK_TIMEOUT_MS`, default 10 s). The migration connection has no statement timeout | Test: second runner gives up after its wait and succeeds once the lock is free. Test: a statement blocked by a table lock fails within its bound, is rolled back, and applies later | Pass |
| R4 | Migration files must not control transactions | Files containing BEGIN, COMMIT, ROLLBACK, SAVEPOINT and similar, or statements that cannot run in a transaction, are refused when read, before any database work. `db:check` therefore catches them in CI without a database. **Revised after the second review (P1):** the first version stripped comments before strings, so `SELECT '--'; COMMIT;` hid the COMMIT. It is replaced by a single-pass scanner that reads the text in order (line and nested block comments, standard and escape strings, dollar quoting, quoted identifiers) and refuses anything unterminated. A second barrier checks, after each file has run, that the session is still in the transaction the runner opened | Regression test with the reviewer's exact input: refused before execution, table not created, no history table. Fifteen inputs where transaction control follows a string, comment, dollar quote or quoted identifier are all detected; nine inputs with the words inside text are not refused; four unterminated inputs are refused. Second barrier proved with the statement check bypassed. Transaction control inside a DO block is rejected by PostgreSQL and rolled back | Pass |
| R5 | Recovery after a runner is terminated | No code change needed; behaviour proved. **Revised after the second review (P2):** the first test only slept and could have passed without migration 2 starting. It now uses a database barrier | Migration 2 creates a table and then waits on a lock the test holds. The test confirms the runner's session is blocked there, inside an open transaction that has already written, with the table still invisible to others; kills the runner; releases the barrier; waits for the session to end; and asserts nothing from migration 2 exists or is recorded. The next run then applies migrations 2 and 3 exactly once | Pass |

### Migration runner: scope and limits

The runner is accepted for **transactional SQL only**. It does not support, and refuses:

- transaction control inside a migration file;
- `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX ... CONCURRENTLY`, `VACUUM`, `CREATE` or `DROP DATABASE`, `CREATE` or `DROP TABLESPACE`, `ALTER SYSTEM`;
- SQL-standard function bodies written with `BEGIN ATOMIC` (use a dollar-quoted body).

Also outside its scope: large data backfills that should commit in batches, and down migrations (it is forward-only). Any of these needs a separately reviewed procedure. The refusal is a lexical check on the beginning of each top-level statement; it is a guard against mistakes, not a security control or a full SQL parser. The second barrier detects a file that ended the runner's transaction after the fact; it stops the run and reports it, but cannot undo what such a file committed. If a file both ends the transaction and then fails, the failure is reported without that specific diagnosis.

## Not verified

- `tools/dev/docker-compose.yml` was not executed in slice 1. It was exercised later in CI: see docs/delivery/FOUNDATION_SLICE_2.md.
- GitHub CI passed on pull request 1 for slice 1 as first pushed (commits `0899c08` and `a627ae3`). Its result for the review fixes is reported on their own pull request, not in this file.
- Only Linux was used in slice 1. Windows was exercised later on a CI runner: see docs/delivery/FOUNDATION_SLICE_2.md. macOS is untested.
- No load, security or dependency-vulnerability review was done.

## Choices in this slice that need confirmation

| Choice | Why | Alternative |
|---|---|---|
| A small in-repository migration runner instead of a library | Accepted by Abdullah on 13 Nov 2026 for transactional SQL only, with the limits listed above | An established migration library if non-transactional operations become necessary |
| Readiness treats pending migrations as "not ready" | Confirmed by Abdullah on 13 Nov 2026; liveness stays independent; migrations run separately before traffic | — |
| Tests run on compiled output with Node's test runner | NestJS 12 is ES-module only; this avoids a test framework and its transform configuration | A test framework with TypeScript transform |
| PostgreSQL 16 | It is what the evidence ran on | A newer major, after re-running the checks |
