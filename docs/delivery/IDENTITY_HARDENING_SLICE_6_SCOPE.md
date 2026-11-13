# Trucker: identity database hardening slice — scope and acceptance criteria (approved with conditions)

Version 1.1, 13 November 2026. Owner: Abdullah. Version 1.1 adds the decisions of the review of
pull request #8 (section 2.1) and criteria IH-14 and IH-15.

**Status: scope approved by Abdullah on 13 November 2026 (H-1, H-2), with conditions on H-3,
H-4 and H-5 and further requirements (section 2).** The build is recorded in
`IDENTITY_HARDENING_SLICE_6.md`; this document is the standard it is measured against.
Approval of the scope is not approval of the pull request. H-3 is approved in part only: see
section 2 and section 3 of the record.

## 1. What the slice does

Takes away every right the API's database role has on the identity tables and replaces them
with database functions, one per operation, that run as the tables' owner. No endpoint, answer
or screen changes. It closes the limit accepted in slice 5: someone who had taken over the
API's database role could read and write sessions.

## 2. Decisions and conditions (13 November 2026)

| # | Decision | Effect |
|---|---|---|
| H-1 | Scope and criteria approved, with the conditions below | This document |
| H-2 | Recheck pull request #7 at `128f035`, merge it into `staging`, watch CI, then build on a fresh branch | Done before the build: merge `8b57758`, CI run 43452344430 green |
| H-3 | Database-generated codes approved. Salted SHA-256 and a plaintext delivery queue are **not** approved automatically: document the storage threat model and the proposed protection first; keep production sign-in closed without a supplier | Threat model and proposal: record, section 3. No queue is built. No code is created outside a database marked local-development or test. The stored form awaits Abdullah's decision |
| H-4 | Test clock only in test-marked databases; the API's role must not change that mark | IH-5 |
| H-5 | Enforce the approved limits from protected database configuration. Caller-supplied values must never loosen them; broad safety bounds alone are insufficient | IH-6. No function takes a limit at all |
| R-1 | Secure randomness | IH-4 |
| R-2 | Restricted function execution | IH-2 |
| R-3 | Safe function search paths | IH-2 |
| R-4 | No API-role access to secrets or queue contents | IH-1, IH-3 |
| R-5 | Session validity checks enforce both idle and absolute expiry | IH-8 |
| R-6 | Test direct function calls as the restricted role: attempts to weaken limits, forge sessions, reach another person's data, and retry revoked sessions | IH-6, IH-3, IH-7, IH-8 |
| — | Open a focused pull request; do not merge it. Defer wording and translation corrections to the final audit. Leave TruckLink, `main` and deployments untouched | Section 4 |

### 2.1 Given on review of pull request #8 (13 November 2026)

| # | Decision | Effect |
|---|---|---|
| T-1 | Security decisions must use the current database time, including after lock waits, while preserving the protected test clock. Changing `now()` alone is insufficient if time is still captured before waiting | IH-14 |
| T-2 | Deterministic tests: a transaction opened before expiry but verifying afterwards; a verification blocked until the code expires. Session expiry and consumed-code retries go through the shared live-session rule too | IH-14, IH-8 |
| H-3a | The external-key HMAC direction is accepted, subject to review of the completed implementation | Record, section 3.3 |
| G-1 | Encrypted database connections and protection against parameter logging are mandatory production gates | IH-15 |
| H-3b | Provisional. The supplier slice must define send failures, retries, crashes and duplicate delivery before choosing its final design | Record, section 3.5. Nothing is built |

## 3. Acceptance criteria

Each criterion is proved by an automated test against a real PostgreSQL database, run as the
API's own role where it concerns what that role can do. A criterion without a passing test is
not done.

| ID | Criterion |
|---|---|
| IH-1 | The API's role has no privilege of any kind on `person`, `session`, `sign_in_challenge`, `terms_acceptance`, `identity_event`, the settings, the clock, and cannot change the environment mark. Each direct read and write is tested and refused, and the privilege catalogue is checked so that a later grant fails CI |
| IH-2 | Nothing in the schema is executable by PUBLIC. The API's role may run exactly a named list of functions, checked against the catalogue. The building blocks (code generation, hashing, the live-session rule, the clock, event writing) cannot be called by it. Every function sets its search path explicitly, starting with `pg_catalog` and ending with `pg_temp`; temporary tables named like the real ones change nothing |
| IH-3 | As the API's role: a code cannot be chosen or supplied; a session cannot exist without a correct code, whatever identifiers and hashes are supplied; a correct code signs in only the number it was sent to; no function returns a code hash or a token hash |
| IH-4 | Codes are drawn from PostgreSQL's cryptographic random source, are six digits with leading zeros kept, and no digit is favoured in any position (tested on 30,000 draws). The stored hash is HMAC-SHA-256, checked against the published test vectors |
| IH-5 | The clock can be fixed only in a database marked `test`. A fixed clock is ignored the moment the mark is anything else. The API's role can write neither the clock nor the mark, and no function it can call takes a time |
| IH-6 | Limits are read inside the database from one protected row. No function the API's role can call takes a number, a time or a period, so there is nothing through which a limit could be loosened. Settings invented by the caller are not read. A change by the migration role applies at once. Each value is range-checked by the table. Production does not start until the values are recorded as reviewed; an old limit name left in the API's configuration stops the API |
| IH-7 | The account functions take no identifier of a person. With A's session: B's account is not returned, B's sessions are not listed, ending B's session answers exactly like a session that does not exist, registration changes A only |
| IH-8 | (Extended on review.) A session is live only when it is not ended, is inside the idle period and is inside the absolute limit (the earlier of the limit stored when it was created and the limit in force now). One rule, used by every function including the organisation rules. A revoked, idle or over-age session is refused by every function, including before anything has marked it ended; repeating the sign-in request returns its session only while that session is live by the same rule: not when it is revoked, idle or over age |
| IH-9 | Simultaneous wrong attempts never exceed the limit; two simultaneous correct attempts create one session (the existing API tests, now running against the functions) |
| IH-10 | The session check made on every request is one statement and sends the hash of the token, never the token |
| IH-11 | In a database that is unmarked or marked production, no code is created and no demonstration terms are recorded, whatever the caller asks |
| IH-12 | Every existing API test and browser check passes with unchanged behaviour, with the API connected as its restricted role |
| IH-13 | All three CI jobs pass, including Windows, where the migration role is not a superuser |
| IH-14 | Every decision that depends on time reads the clock when it is made: after the locks it needs are held, never at the start of the statement or transaction. The clock is the server's current time, or the fixed test clock in a database marked `test`. Proved deterministically: a verification queued behind a lock until the code expires is refused, and one second earlier is accepted; a transaction opened before expiry cannot use the code afterwards, on the test clock and on the real clock; the same for the session check, ending sessions, registration, creating and changing an organisation, and the repeat of a sign-in |
| IH-15 | A production API does not start unless the server reports its connection as encrypted and is set never to write statement parameters to its log. The API's role cannot change those settings |

## 4. Scope

| In scope | Out of scope |
|---|---|
| One migration: functions, protected settings, clock, revoked privileges | A message supplier, a delivery component or a delivery queue |
| The identity service rewritten as calls to the functions | Account recovery, staff sign-in |
| Organisation creation limit and timestamps taken from the database, not the caller | Any screen or wording change |
| A command for the migration role to show and change the settings | Limits per device or network address |
| Tests as the restricted role | Setting up encrypted connections and log settings on a production server (a deployment matter). This slice only refuses to start without them |
