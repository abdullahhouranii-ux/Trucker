# Slice 6: identity database hardening

Date: 13 November 2026. Branch `feat/identity-database-hardening`, pull request against
`staging`, built from `staging` at `8b57758` (after pull request #7 was merged). Not merged.

Scope and acceptance criteria, as approved with conditions: `IDENTITY_HARDENING_SLICE_6_SCOPE.md`.
No wording or translation was changed; `FINAL_AUDIT_BACKLOG.md` is untouched.

## 1. What changed, in one paragraph

The API's database role can no longer read or write people, sessions, sign-in codes, terms
acceptances or identity history. It can only call functions that each do one narrow thing.
The database creates and compares one-time codes, reads every limit from a protected row and
reads the time from its own clock. Nothing the API sends can choose a code, loosen a limit or
move time. Endpoints, answers and screens are unchanged.

## 2. What was built

**Database** (`db/migrations/0004_identity_hardening.sql`)

| Object | Purpose |
|---|---|
| `security_setting` | One protected row: code lifetime, attempts, resend wait, codes per hour, session idle period and absolute limit, organisations per person, and whether the values were reviewed for production. Range-checked. No right for the API's role |
| `test_clock`, `clock_now()` | The only source of time: the server's time at the moment of the call (not the start of the transaction), except in a database marked `test`, where the migration role may fix it |
| `random_code()` | Six digits from PostgreSQL's cryptographic source, with values that would favour some codes thrown away |
| `hmac_sha256()`, `code_hash()` | The stored form of a code (section 3) |
| `session_state()`, `live_session()` | The one rule for whether a session is live at a given moment: not ended, inside the idle period, inside the absolute limit. Every function asks it, including the repeat of a sign-in |
| `sign_in_request_code()` | Creates the code. Refuses in a database that is not marked local-development or test |
| `sign_in_verify_code()` | Compares the code, counts attempts, creates the person and the session |
| `session_check()` | The check on every request: one statement. Ends and records an expired session |
| `my_account()`, `my_sessions()`, `complete_registration()`, `revoke_my_session()`, `revoke_my_other_sessions()` | The caller's own account. None takes an identifier of a person |
| `request_person()` (replaced) | Now applies the idle period too, through `live_session()` |
| `create_organisation()` (replaced) | No longer takes the time or the limit from its caller |
| `organisation_stamp` trigger | The time of a change is the database's; the API's role may no longer write `updated_at` |
| Privileges | Every right on the identity tables revoked; row security with no policy as a second barrier; every function closed to PUBLIC; the API's role granted exactly sixteen |

**API**

| Change | Where |
|---|---|
| Identity service is now thin calls to eight functions; it creates and compares no code | `identity/identity.service.ts`, `identity/secrets.ts` |
| Limits removed from the API's configuration. An old name still set stops the API with a message naming it | `config/config.ts` |
| Production start also requires the settings to be recorded as reviewed, an encrypted connection to the database, and a server that never logs statement parameters | `database/access.ts` |
| `npm run db:settings -- show` and `-- set name=value ... [--reviewed-for-production]`, run as the migration role | `cli/security-settings.ts`, `database/settings.ts` |
| `npm run db:mark`: marks a local database local-development without loading countries, with the same three safeguards as `db:fixtures` | `cli/local-database.ts` |

**Web**: no change to the application. The browser checks now shorten the resend wait through
`db:settings` and put the previous values back afterwards.

## 3. Storage of one-time codes: threat model and proposed protection (H-3)

Abdullah approved database-generated codes and asked for the threat model before any stored
form or delivery queue is accepted. This section is that document. On review of pull request
#8 he accepted the direction in 3.3 (a key held outside the database), subject to review of
the completed implementation, and left 3.5 provisional. The proposal of
13 November recommended salted SHA-256 and a delivery queue; the table in 3.2 shows why that
recommendation was wrong, and it is withdrawn.

### 3.1 What is being protected

A six-digit code: one million possible values, valid for five minutes, five attempts, single
use, replaced by any newer code for the same number. Whoever holds a live code and its
challenge identifier can sign in as that number.

### 3.2 Who might get at it, and what each stored form gives them

| Who | Unkeyed hash (plain or salted SHA-256) | Key kept inside the database | Key kept outside the database (proposed) |
|---|---|---|---|
| Outside attacker through the API | Guessing only, at the permitted rate: 5 tries per code, 5 codes per hour per number | Same | Same |
| Someone running statements as the API's database role | Cannot read the table. Can only call the functions | Same | Same |
| Someone who can **read** the database while it is live: a replica, a read-only account, a storage snapshot taken now, a backup restored within five minutes | **Signs in as anyone.** Asks for a code for the victim's number, reads the hash, tries a million values in under a second. A salt does not help: it is in the same row | **Signs in as anyone**: the key is in the same database | Learns nothing: the key is not in the database |
| Someone with an old backup | Nothing usable: every code in it has expired | Same | Same |
| Someone who can see statements in transit or in the database's logs | Sees the typed code at verification, when that same statement has just used it up | Same | Also sees the key. With a live read of the table as well, this becomes the previous row. Mitigation in 3.4 |

The decisive row is the third. Session tokens are safe against a read-only observer already:
the table holds only a hash of a token with 256 bits of randomness. The code hash is the one
stored value that a read-only observer could turn into a sign-in. So an unkeyed hash, salted
or not, would make read access to the database equal to taking over any account.

### 3.3 Protection as built (direction accepted, implementation under review)

- The database creates the code and stores `HMAC-SHA-256(key, "code:" + challenge + ":" + code)`.
- The key is derived by the API from its secret (`IDENTITY_SECRET`) and passed with each
  request. The database uses it and never stores it. It is a derived value, not the secret
  itself: it cannot be used to forge a session token.
- This keeps the protection the code hash had before this slice (keyed with the server
  secret), while moving code creation and comparison into the database.
- A caller who supplies a key of its own gains nothing: it still does not know the code the
  database drew, cannot read the hash, and gets the same five attempts as anyone.

Alternatives considered and not proposed: salted SHA-256 (third row above); a key in a
protected table (same row); the `pgcrypto` extension (adds an installation requirement for
nothing the built-in `sha256` cannot do; the HMAC here is checked against RFC 4231 vectors).

### 3.4 What this does not cover

| Limit | Why it is acceptable now | What closes it |
|---|---|---|
| The key and the typed code travel to the database as statement parameters | Development and test only; production sign-in is closed | **Mandatory production gates, now enforced at start-up:** the API refuses to start in production unless the server reports the connection as encrypted and has `log_parameter_max_length` and `log_parameter_max_length_on_error` at 0 for the API's role. The first cannot be changed by that role (tested). The second can be changed by any role for its own connection, which PostgreSQL does not allow to be forbidden: someone running statements as the API's role could turn on parameter logging for statements that fail on that connection, and would still need to read the server's log to gain anything. Not covered by the gate: checking the server's certificate (a connection-string matter), and a connection pooler placed between the API and the database, which would hide what the server sees |
| In a database marked local-development or test, the function returns the code to a caller who asks | That is the development display, and the mark cannot be given to a production database | Nothing to close: by design |
| The comparison is not constant-time | The value compared is a keyed hash the attacker can neither read nor choose | — |
| Someone who controls the API process holds the secret | Database permissions cannot fix that | Out of scope |

### 3.5 Delivery, when a message supplier exists: provisional, not built

No queue is built. A plaintext queue would recreate the third row above: anyone who could read
it would hold live codes. Proposed instead, for the supplier slice:

| Option | Codes at rest | Assessment |
|---|---|---|
| Plaintext queue read by a delivery role | Yes, readable | Not proposed |
| Queue encrypted to the delivery component's public key | Ciphertext only | Workable; needs `pgcrypto` and key management |
| **No queue.** The API creates a pending challenge with no code. A separate sender component, with its own database role and its own key, calls a function that draws the code, stores only the keyed hash, and returns the code once, in the answer | Never | **Proposed.** Nothing to steal at rest; the API's role never sees a code in any environment |

**Status: provisional (Abdullah, 13 November 2026).** No design is chosen. Before one is, the
supplier slice must define, and test, what happens when:

| Case | Question the design must answer |
|---|---|
| A send fails | Is the code spent? Does the person get a new one, and does the failed one count against the hourly limit? |
| A send is retried | Is the same code sent again or a new one? If the same, where is it held meanwhile, given that nothing may hold it readably at rest? |
| The sender crashes after drawing a code and before sending it | How is the challenge recovered or abandoned, and what does the person see? |
| The supplier delivers twice, or late | Two messages with one code, or two codes of which only the newest works: which, and is that what the person is told? |

The "no queue" option above answers the first and third by drawing a new code each time, which
has costs (more codes drawn per sign-in, limits reached sooner). That trade-off is not decided.

Until a supplier is chosen and this is decided, production sign-in stays closed three ways: the
API's configuration (`SIGN_IN_CODE_DELIVERY` is `none`), the database (no code is created unless
it is marked local-development or test), and the mark itself (a production mark is permanent).

## 3A. Time: read when a decision is made (review of pull request #8)

The first version read the time with `now()`, which is the start of the transaction, and read
it at the top of each function, before waiting for locks. Two defects followed: a transaction
left open kept judging by the time it began, and a request that queued behind a lock was
judged by the time it arrived. Either let an expired code or session be used.

What changed:

| Rule | How |
|---|---|
| The clock is the server's time now | `clock_now()` returns `clock_timestamp()`, or the fixed test clock in a database marked `test` |
| Lock, then look at the clock, then decide | Every function that changes something first takes every lock it will need, then reads the clock once, then judges expiry and limits, then acts. Nothing after the clock is read waits for a lock |
| One rule for a live session | `session_state(session, moment)`. The session check, the account functions, the organisation rules and the repeat of a sign-in all ask it |
| Locks are taken in one order | The number, then the challenge, then the session; a person's sessions in identifier order. Two requests cannot block each other for ever, and a session of another person is never locked |
| Organisation changes | Creating one asks again who is signed in after its lock. Changing one is judged again by the database once the row is locked; the API answers 401 |

| Function | Locks taken before the clock is read |
|---|---|
| Ask for a code | The number; the number's open codes |
| Check a code | The number; the challenge; the session it produced, if any |
| Session check | The session |
| Complete registration | The caller's session; the person |
| End a session, end all others | The caller's session and the sessions to end, together |
| Create an organisation | The per-person creation lock |

Tests (`hardening.test.ts`, section "Time is read when a decision is made"). None depends on
how long a step takes: a second connection holds a lock, the test waits until the database
reports the first as waiting, moves the clock, and releases.

| Test | Shows |
|---|---|
| Verification blocked until the code expires | Refused, behind the challenge lock and behind the number lock; one second earlier, the same wait signs in |
| Transaction opened before expiry, verifying afterwards (test clock) | Refused |
| The same on the real clock, in a database marked local-development | Deadlines are moved to "this instant" after the transaction begins: by its start time they have not passed, by the clock they have. Code refused; session dead to every function; the ending is stamped with the real moment |
| Session check blocked until idle | Ends the session; one second earlier leaves it open |
| End a session, end others, complete registration: blocked until the caller is idle | Nothing changed |
| Create and change an organisation: blocked until the caller is idle | Nothing created, nothing changed, no history entry |
| Code request blocked for the resend wait | Accepted, and stamped with the time after the wait |
| Repeat of a sign-in | Returns the session at 59 seconds of a one-minute idle period, refuses at 60, and refuses when it waited past it |

Nine defects of this kind were put into the migration one at a time (the clock as `now()`;
the clock read before the locks in each of six functions; the repeat checking only for
revocation; creation not looking again after its lock). Each was caught.

## 4. How each condition is met

| Condition | How | Proved by |
|---|---|---|
| H-4 clock | `test_clock` accepts a row only when the mark is `test`; `clock_now()` ignores it otherwise; the API's role has no right on the clock or the mark | Clock fixed, mark changed, clock ignored; writes refused in three other marks |
| H-5 limits | One protected row. No function the API's role can call takes a number, time or period (checked against the catalogue). The API no longer has limit settings | Look-alike settings set by the caller: code still locks at 5. Old function signature with a limit: does not exist. Limit tightened by the migration role applies at once |
| Secure randomness | `gen_random_uuid()`, which PostgreSQL fills from `pg_strong_random` (`src/backend/utils/adt/uuid.c`); rejection sampling removes modulo bias | Source check; 30,000 draws, each digit in each position within six standard deviations |
| Restricted execution | `REVOKE ALL ... FROM PUBLIC` on every function; sixteen granted to the API's role | Catalogue compared with the named list; building blocks refused |
| Safe search paths | Every function: `pg_catalog, trucker, pg_temp` (or `pg_catalog, pg_temp`). The functions kept from slice 5 were altered to match | Catalogue check; temporary look-alike tables change nothing |
| No access to secrets or queue contents | No table privileges; no function returns a hash; there is no queue | Privilege catalogue; answers searched for every stored hash |
| Idle and absolute expiry | `live_session()` is the only rule, used by the session check, the account functions and `request_person()` | Idle and over-age sessions refused by every function before anything marks them ended |
| Direct calls as the restricted role | `apps/api/src/identity/hardening.test.ts` connects only as the API's role for the attempts | 37 tests |

## 5. Checks and results

Run against PostgreSQL 16, locally and in CI. The first version (`43bdf31`) passed CI run
43456265992; the version with the time fixes (`da3556d`) passed run 43466073467.
All three jobs passed in both.

| Check | Result |
|---|---|
| API tests | 165 pass, 0 fail (126 before this slice; 37 in `hardening.test.ts`, one more each in the identity and organisation files) |
| Web unit tests | 24 pass |
| Tool tests | 9 pass |
| Browser checks | 706 pass, against the real API connected as its restricted role |
| Format, lint, type check, migration file check | Pass |

**Do the new tests detect defects?** Ten defects were put into the migration one at a time
and the identity tests run against each. Every one was caught:

| Defect introduced | Tests failing |
|---|---|
| Idle period not applied in `live_session()` | 1 |
| `SELECT` on `session` granted to the API's role | 2 |
| Codes from the ordinary `random()` | 1 |
| Fixed clock honoured whatever the mark | 1 |
| Unkeyed code hash | 1 |
| A building block granted to the API's role | 3 |
| Codes created in any database | 1 |
| Absolute limit not rechecked against the settings | 1 |
| Any session revocable by identifier | 2 |
| One function without `pg_temp` in its search path | 1 |

**A test fault found and fixed.** While the time fixes were being checked, the whole API suite
failed twice in about seventeen runs, with every test passing and a stray "terminating
connection" error reported afterwards. Cause: a connection pool reports itself closed a moment
before the server has released its connections, and the test database was then dropped by
force, cutting one off. The helper now waits until the server shows no connection left before
dropping. Thirty consecutive runs then passed. This is the likely cause of the single
unexplained failure recorded in slice 4; that is an inference, not something shown.

The existing API tests for sign-in, sessions and registration were not weakened: they now run
with the API connected as its restricted role and with the clock in the database.

## 6. Changes to set-up

- **Sign-in needs a marked database.** The database creates codes only when marked
  local-development or test. `npm run db:fixtures` already sets the mark; `npm run db:mark`
  sets it without loading countries. Both need `TRUCKER_LOCAL_FIXTURES=local-development-only`.
- **Limits moved.** `SIGN_IN_CODE_TTL_SECONDS`, `SIGN_IN_CODE_MAX_ATTEMPTS`,
  `SIGN_IN_CODE_RESEND_WAIT_SECONDS`, `SIGN_IN_CODE_MAX_PER_HOUR`, `SESSION_IDLE_MINUTES`,
  `SESSION_ABSOLUTE_HOURS` and `ORGANISATION_CREATION_LIMIT` are no longer read by the API. Set
  in the environment, any of them stops the API with a message. Use `npm run db:settings`.
- **Production** additionally refuses to start until the settings are recorded as reviewed
  (`npm run db:settings -- set ... --reviewed-for-production`). The seeded values are the
  development defaults from slice 4 and slice 5; they have not been reviewed for production.
- `RETRY_KEY_RETENTION_HOURS` stays an API setting.

## 7. Limits and what is not claimed

- No conformance or penetration-test claim. The tests show what the API's role cannot do
  through the statements tried; they are not a proof.
- Changes to the settings are not recorded in a history, only stamped with a time.
  "Reviewed for production" records that someone said so.
- The database does not check the version of the demonstration terms; the API does.
- The time on a retry key is still the API's. It affects only the caller's own retries.
- The caller's own full phone number is returned to the API, which masks it.
- No limit per device or network address. No account recovery. No message supplier.
- A request that waits for a lock is still bounded only by the statement timeout (5 seconds
  by default): it is refused if its deadline passes meanwhile, not hurried.
- The production gates read what the server reports. They cannot see a connection pooler
  between the API and the database, and do not check the server's certificate.

## 8. Needs Abdullah

| # | Decision | State |
|---|---|---|
| H-3a | External-key HMAC for stored codes | Direction accepted on 13 November 2026, subject to review of the completed implementation: this pull request |
| H-3b | Delivery design | Provisional. Decided in the supplier slice, after the four cases in 3.5 are defined |
| H-6 | Review and merge of this pull request | Open |
