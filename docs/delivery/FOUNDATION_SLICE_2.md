# Foundation slice 2: standard API errors, request identifiers, local helpers, Docker and Windows verification

Date: 13 November 2026. Status: **on a review branch with a pull request against `staging`; not merged, not in `main`, not deployed.**

## Scope

| In this slice | Not in this slice |
|---|---|
| One error body for every API error response | Any business module, table or endpoint (all gated: docs/specs/STAGE_3_ARCHITECTURE.md, section 11) |
| Request identifier on every response and in one log line per request | Sign-in, permissions, the API contract generator |
| Cross-platform local helper scripts in `tools/dev` | Audit log, outbox, idempotency store, row-level security (F-07 to F-10) |
| CI job that exercises the Docker compose database | Docker Desktop on Windows |
| CI job that follows the native Windows setup | A Windows desktop machine |

## What was built

### Standard error body

Every error response from the API has this body, and only these fields:

```json
{ "code": "not_found", "message": "The requested resource was not found.", "requestId": "…" }
```

`details` is added only when application code supplies it. `code` is stable and for programs; `message` is for people.

| Source of the error | What the client sees |
|---|---|
| Application code raising `ApiError` | Its own status, code, message and details |
| Framework or library error with a 4xx status (unknown route, malformed body, oversized body) | The standard code and message for that status. The original message is never echoed |
| Anything else | 500 `internal_error` with a generic message. Name, message and stack are logged on the server with the request identifier |

Standard codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `method_not_allowed`, `conflict`, `payload_too_large`, `unsupported_media_type`, `unprocessable`, `too_many_requests`, `internal_error`, `service_unavailable`; `request_error` for any other 4xx.

**Exception:** `/health/live` and `/health/ready` keep their own bodies, including the 503 from readiness, because infrastructure reads them. They do carry the request identifier header.

### Request identifiers

- Every response has an `X-Request-Id` header; error bodies carry the same value as `requestId`.
- An inbound `X-Request-Id` is kept only if it is 8 to 128 characters of letters, digits, dot, underscore or hyphen. Anything else is replaced by a generated identifier.
- One JSON log line per request: `event`, `requestId`, `method`, `path` (no query string), `status`, `durationMs`. No headers, bodies or query values are logged.

### Local helpers (`tools/dev`, plain Node.js, same commands on Linux, macOS and Windows)

| Command | What it does |
|---|---|
| `npm run dev:env` | Creates `.env` from `.env.example`; never overwrites an existing `.env` |
| `npm run dev:doctor` | Reports each prerequisite as ok, MISSING or optional; exits 1 if a required one is missing |
| `npm run dev:db:up` / `dev:db:down` / `dev:db:reset` / `dev:db:status` | Starts (and waits for), stops, wipes and restarts, or shows the Docker database |
| `npm run dev:migrate` | Applies migrations using the values in `.env` |
| `npm run dev:verify` | Runs the full verification using the values in `.env` |
| `npm run dev:api` | Builds and starts the API using the values in `.env` |
| `npm run versions` | Prints the exact Node.js, npm and PostgreSQL versions in use |

Values already set in the real environment take precedence over `.env`.

## Acceptance evidence

Tested commit: `a392194` (code and CI jobs; the later commit on the branch adds only this record and wording). GitHub CI run 43376773715: all three jobs succeeded.

| ID | Criterion | Evidence | Result |
|---|---|---|---|
| S2-01 | Unknown route returns 404 with the standard body | Test; also called against the started API in the `compose` and `windows` jobs | Pass |
| S2-02 | Malformed JSON returns 400 `bad_request` without the parser message; oversized body returns 413 | Tests | Pass |
| S2-03 | Unexpected exception returns a generic 500; detail is logged with the identifier; a framework exception's own message is not leaked | Tests assert the response contains none of the secret text, exception name, stack or file names | Pass |
| S2-04 | A deliberate application error keeps its code, status and details | Test | Pass |
| S2-05 | Every response carries `X-Request-Id` | Tests on success, 404, 409, 500 and both health endpoints | Pass |
| S2-06 | Valid inbound identifier echoed; invalid replaced | Test with five invalid forms | Pass |
| S2-07 | One log line per request without query string, headers or body | Test with secrets placed in the query, a header and the body | Pass |
| S2-08 | Health endpoints keep their bodies and status codes | Existing health tests, now also asserting the header | Pass |
| S2-09 | Helpers run on Linux and Windows with the same npm commands; `.env` never overwritten | Linux: run locally and in the `compose` job. Windows: `dev:doctor` and `versions` ran in the `windows` job. `.env` overwrite checked locally. **The Docker helpers were not run on Windows** | Pass, with that limit |
| S2-10 | Prerequisite check reports each item and exits non-zero when a required one is missing | Run locally with and without `DATABASE_URL`: exit 0 and exit 1 | Pass |
| S2-11 | Docker: compose database started through the helper; full suite passes against it | `compose` job: `dev:db:up`, `dev:doctor` "Ready", 44 of 44 tests, migrate, API started and called, `dev:db:reset` shown to wipe the data, `dev:db:down` | Pass |
| S2-12 | Windows: install, format, lint, type check, migration checks and the suite pass; SQL checked out as LF; started API answers | `windows` job: `i/lf w/lf attr/text eol=lf` for the SQL file, `dev:doctor` "Ready", 44 of 44 tests, migrate, API started, both health endpoints and the 404 body checked | Pass |
| S2-13 | Existing tests still pass; versions recorded per run | 44 tests in every job (34 existing plus 10 new) | Pass |

### Exact versions used in each verification run

| Run | Node.js | npm | PostgreSQL | Platform |
|---|---|---|---|---|
| CI `verify` (run 43376773715) | 22.23.4 | 10.9.9 | 16.16 | Linux x64 |
| CI `compose` (same run) | 22.23.4 | 10.9.9 | 16.16 | Linux x64 |
| CI `windows` (same run) | 22.23.4 | 10.9.9 | **17.11** | Windows x64 |
| Local, before pushing | 22.23.4 | 10.9.9 | 16.15 | Linux x64 |

Node 22 and PostgreSQL 16 remain major-version selections. The Windows runner provides PostgreSQL 17, not 16, so the Windows result shows the code and setup steps work on Windows; it is not evidence for PostgreSQL 16 on Windows.

## Review fix: starting processes without a shell (13 November 2026)

Finding from review of `a4eba1e`: the helper scripts started commands through a shell on Windows, so a path or argument containing spaces or shell-special characters could be split or interpreted.

| Change | Detail |
|---|---|
| No shell, anywhere | `tools/dev/lib.mjs` starts every process with `shell: false` and an argument array. The option cannot be overridden by a caller |
| npm on Windows | `npm` there is a batch file, which cannot be started without a shell. The helpers start the Node.js binary with npm's JavaScript entry point (`npm-cli.js`) instead, so argument boundaries are preserved. If that file cannot be found on Windows the helper refuses, with no shell fallback |
| `tools/dev/versions.mjs` | Uses the same launcher instead of its own shell call |
| Tests (`tools/dev/lib.test.mjs`, 9 tests, part of `npm run verify` on every platform) | 22 hostile arguments (spaces, `&`, `|`, `;`, `<`, `>`, `%PATH%`, `$(...)`, backticks, quotes, carets, trailing backslashes, an empty argument) arrive unchanged; no redirect target is created; a script and working directory whose path contains spaces, `&` and parentheses run; `with-env.mjs` passes arguments through unchanged; npm is resolved to `node` + `npm-cli.js`; a missing `npm-cli.js` is refused on Windows; npm run with a `--prefix` containing spaces passes script arguments with spaces; no helper script requests a shell |
| Windows CI job | Now checks the whole repository out into `trucker repo with spaces` and runs everything from there |

Limit: arguments passed **through** `npm run ... -- <args>` are handed by npm to the script through the platform shell, as npm always does. The test for that path uses arguments with spaces only; shell-special characters are covered for processes the helpers start directly. The CI results for this fix are recorded in the pull request description.

## Verified and not verified

| Item | State |
|---|---|
| `tools/dev/docker-compose.yml` and the Docker helpers on Linux | **Verified** in CI (`compose` job) |
| Native Windows setup: checkout line endings, install, checks, tests, migrate, start and call the API | **Verified** on a GitHub Windows runner (`windows` job), with PostgreSQL 17.11 |
| Docker Desktop on Windows (option A in the Windows instructions) | **Not verified** |
| A repository path containing spaces on Windows | **Verified** on the Windows runner after the review fix |
| A Windows desktop machine, the PostgreSQL 16 installer, antivirus interference | **Not verified** |
| macOS | **Not verified** |
| Load, security review, dependency vulnerability review | Not done |

## Choices in this slice

| Choice | Why | Alternative |
|---|---|---|
| Health endpoints are exempt from the standard error body | Probes and load balancers read them; their format is part of slice 1's contract | Wrap them too, and change what infrastructure parses |
| Standard messages replace framework messages for all 4xx | Framework texts leak paths and parser detail and are not stable | Pass selected framework messages through |
| Inbound request identifiers are accepted only in a narrow format | Prevents log injection and oversized values | Always generate; loses correlation with a caller's trace |
| Every request is logged, health checks included | Simplest correct behaviour for now | Exclude health checks once volume matters |
| Helper scripts are Node.js, not shell or PowerShell | One implementation for every platform | Two sets of scripts |
