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
| `test_clock`, `clock_now()` | The only source of time. The database's own clock, except in a database marked `test`, where the migration role may fix it |
| `random_code()` | Six digits from PostgreSQL's cryptographic source, with values that would favour some codes thrown away |
| `hmac_sha256()`, `code_hash()` | The stored form of a code (section 3) |
| `live_session()` | The one rule for whether a session is live: not ended, inside the idle period, inside the absolute limit |
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
| Production start also requires the settings to be recorded as reviewed | `database/access.ts` |
| `npm run db:settings -- show` and `-- set name=value ... [--reviewed-for-production]`, run as the migration role | `cli/security-settings.ts`, `database/settings.ts` |
| `npm run db:mark`: marks a local database local-development without loading countries, with the same three safeguards as `db:fixtures` | `cli/local-database.ts` |

**Web**: no change to the application. The browser checks now shorten the resend wait through
`db:settings` and put the previous values back afterwards.

## 3. Storage of one-time codes: threat model and proposed protection (H-3)

Abdullah approved database-generated codes and asked for the threat model before any stored
form or delivery queue is accepted. This section is that document. What is built follows the
proposal in 3.3 and is called out as awaiting his decision in section 8. The proposal of
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

### 3.3 Proposed protection, as built

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
| The key and the typed code travel to the database as statement parameters | Development and test only; production sign-in is closed | Encrypted database connections and no parameter logging, as a deployment requirement before production. Not built |
| In a database marked local-development or test, the function returns the code to a caller who asks | That is the development display, and the mark cannot be given to a production database | Nothing to close: by design |
| The comparison is not constant-time | The value compared is a keyed hash the attacker can neither read nor choose | — |
| Someone who controls the API process holds the secret | Database permissions cannot fix that | Out of scope |

### 3.5 Delivery, when a message supplier exists: proposal, not built

No queue is built. A plaintext queue would recreate the third row above: anyone who could read
it would hold live codes. Proposed instead, for the supplier slice:

| Option | Codes at rest | Assessment |
|---|---|---|
| Plaintext queue read by a delivery role | Yes, readable | Not proposed |
| Queue encrypted to the delivery component's public key | Ciphertext only | Workable; needs `pgcrypto` and key management |
| **No queue.** The API creates a pending challenge with no code. A separate sender component, with its own database role and its own key, calls a function that draws the code, stores only the keyed hash, and returns the code once, in the answer | Never | **Proposed.** Nothing to steal at rest; the API's role never sees a code in any environment |

Until a supplier is chosen and this is decided, production sign-in stays closed three ways: the
API's configuration (`SIGN_IN_CODE_DELIVERY` is `none`), the database (no code is created unless
it is marked local-development or test), and the mark itself (a production mark is permanent).

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
| Direct calls as the restricted role | `apps/api/src/identity/hardening.test.ts` connects only as the API's role for the attempts | 29 tests |

## 5. Checks and results

Run on `43bdf31` against PostgreSQL 16, locally and in CI (run 43456265992: verify, compose and
windows all passed).

| Check | Result |
|---|---|
| API tests | 157 pass, 0 fail (126 before; 29 new in `hardening.test.ts`, one more each in the identity and organisation files) |
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
- One API test failed once in slice 4 and never again; it was not seen in this slice.

## 8. Needs Abdullah

| # | Decision | Recommendation (not an approval) |
|---|---|---|
| H-3a | The stored form of a code: HMAC-SHA-256 keyed with a value derived from the API's secret and never stored (section 3.3), instead of salted SHA-256 | Accept. It is the only option in 3.2 that survives a read of the live database |
| H-3b | Delivery design for the supplier slice: no queue; a separate sender draws and receives the code (section 3.5) | Accept in principle; decide finally with the supplier |
| H-6 | Review and merge of this pull request | — |
