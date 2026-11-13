# Slice 5: organisation onboarding

Date: 13 November 2026. Branch `feat/organisation-onboarding`, pull request against `staging`,
built from `staging` at `28451fa` (after pull requests #5 and #6 were merged). Not merged.

Scope and acceptance criteria, as approved: `ORGANISATION_ONBOARDING_SLICE_5_SCOPE.md`.
Open wording, translation and accessibility items: `FINAL_AUDIT_BACKLOG.md`.

## 1. The journey that now works

A registered person creates a draft shipper organisation, becomes its first administrator,
sees it in their list, and changes its details. Stored in PostgreSQL. English, Arabic and Urdu.
Outside local development nothing can be created: no country is open for registration.

## 2. What was built

**Database** (`db/migrations/0003_organisations.sql`)

| Object | Purpose |
|---|---|
| Role `trucker_app` | The role the API runs as. Owns nothing, cannot bypass row security |
| `organisation`, `membership` | Draft organisations and their administrators |
| `audit_entry` | History, written only by the database |
| `retry_key` | Which record a retry key produced. Never a copy of an answer |
| `country` | Register of countries. Ships empty |
| `environment` | One row marking the database: unmarked, local-development, test or production |
| `request_person()`, `is_member()`, `is_admin()`, `request_organisation()` | The database works out who is asking from the session, and whether they are a member |
| `create_organisation()` | The only way to create an organisation: organisation, first administrator and audit entry together |
| Triggers | Audit entry on every change; fixture and mark safeguards |
| Row-security policies | On `organisation`, `membership`, `audit_entry`, `retry_key` |

**API** (`apps/api/src/organisation/`, `apps/api/src/database/access.ts`)

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /registration/countries` | Signed in | Countries open for registration. Empty means closed |
| `POST /organisations` | Signed in, registered | Create a draft. Needs `Idempotency-Key` |
| `GET /organisations` | Signed in | The caller's organisations |
| `GET /organisations/:id` | Member | One organisation. Otherwise 404, as if it did not exist |
| `PATCH /organisations/:id` | Administrator | Change a draft. Needs the version last seen |
| `GET /organisations/:id/history` | Administrator | Audit history |

**Web** (`apps/web`): `/organisations`, `/organisations/new`, `/organisations/[id]` in each
language, and a link from the account page.

**Local tools**: `npm run db:app-role` (creates the local login for the API's role) and
`npm run db:fixtures` (marks the database local-development and loads the fictional countries;
needs `TRUCKER_LOCAL_FIXTURES=local-development-only`).

## 3. How the three strengthened requirements are met

### 3.1 Isolation checks authenticated membership

The API does not tell the database who the person is. For each transaction it passes the hash
of the session token and, where a request is about one organisation, that organisation's
identifier. The database then:

1. finds the live session for that hash itself and takes the person from it
   (`request_person()`), so an invented, revoked or missing session is nobody;
2. checks for itself that this person has a current membership of the named organisation
   (`request_organisation()`, `is_member()`), so naming someone else's organisation selects
   nothing;
3. applies row-security policies written only in terms of those two answers.

**Membership alone does not make a row readable** (fixed after review, 13 November 2026). In
the first version of this pull request (commit `c7797b1`) the read policy was "the person is a
member", so a request that had selected organisation A could still read organisation B if the
same person belonged to both. Now a request sees the one organisation it selected and nothing
else:

| Request | `organisation`, `membership`, `audit_entry` | Chooser function | `retry_key` |
|---|---|---|---|
| Selected A (member of A and B) | A only | Refused | Nothing |
| Selected B | B only | Refused | Nothing |
| No organisation selected | Nothing | The person's organisations, summary fields only | The person's own keys |
| Forged organisation (not a member, made up, malformed) | Nothing | Refused | Nothing |
| Forged or missing person | Nothing | Empty | Nothing |

The chooser is a separate database function, `my_organisations()`. It is the only path that
crosses organisations. The API's list endpoint uses it and now returns summaries, not full
records; a full record is read by selecting that organisation. The regression test fails on
the old policy (checked by putting the old policy back once, not committed).

Migration `0003` was changed in place for this fix, because it has never been merged or
applied outside test and local databases. A local database that applied the earlier `0003`
must be recreated.

The API's role cannot insert an organisation, a membership or an audit entry, cannot change
policies or functions, and cannot become another role. If the API is started with a role that
row security does not bind (a superuser, a role with BYPASSRLS, the owner of the tables),
organisation endpoints answer `503 organisation_access_closed`, and production does not start.

### 3.2 Stored retries are returned only after authentication and authorisation

Order on every create: (1) the session is authenticated, and a revoked or expired one stops
here with 401; (2) inside the transaction the database confirms the same person; (3) only then
is the retry key looked up, and row security shows a person only their own keys; (4) the key
holds a reference, so the answer is produced by reading the organisation under the same rules
as any read. A person who is no longer a member gets 404.

Retention: `RETRY_KEY_RETENTION_HOURS`, 24 by default. An older key is treated as new. This is a
development default; production must set it explicitly.

### 3.3 Fixture safeguards that are enforced, not only refused in production

| Barrier | Enforced by | What it stops |
|---|---|---|
| The database mark | Trigger on `country` | A fixture row in any database not marked local-development or test |
| The mark moves one way | Trigger on `environment` | Re-marking a production database; unmarking; marking production while fixtures exist |
| Private-use codes | Check constraint | A fixture carrying a real country's code, or a real country entered under a fixture code |
| Loader conditions | `local-database fixtures` | Loading unless `NODE_ENV` is development or test, the acknowledgement is exact, and the database is on this machine |
| API setting | Configuration and `create_organisation()` | Fixtures counting as open unless the API asks for it, on a local database, in a database so marked. Refused in production configuration |
| Production start | `main.ts` | Starting production against a database that is not marked production |
| No write access | Grants | The API's role changing countries or the mark |

A production database must therefore be marked `production` once, deliberately, before the
first production start. That step is recorded here because no deployment procedure exists yet.

## 4. Checks and results

Run on 13 November 2026, Linux, Node.js 22, PostgreSQL 16, headless Chrome.

| Check | Count | Result |
|---|---|---|
| API tests (`npm test -w @trucker/api`) | 126, of which 36 are new | Pass |
| Web unit tests | 24 | Pass |
| Browser checks (`npm run test:browser`) | 706, of which 249 are new | Pass |
| Format, lint, type check, migration check | | Pass |

New API tests, by criterion group:

| Group | What is tested |
|---|---|
| Role and catalogue | The API's role is bound and the migration role is detected as not; 14 attempts to weaken row security and 17 direct writes are each refused; every table has a policy or is on the named list |
| Creating | Registered person only; all-or-nothing under a forced failure; each invalid field named; closed and unknown countries refused; scripts preserved |
| Decisions | Duplicate registration numbers allowed and reveal nothing; five creations then refusal, with three simultaneous requests for the last place |
| Changing | Save, stale save with current values, two simultaneous saves, non-draft refused in the API and in the database |
| Isolation | Selected A, selected B, absent and forged context for a member of two organisations; the chooser function; no context; forged organisation; forged, invented and revoked person; creation through the function with a forged session; cross-person read, change and history against a missing record; listing for one and two memberships and after a membership ends; one pooled connection across people, after refusals, rollback and timeout; access after sign-out |
| History | Two entries with who, when, request identifier, before and after; a refused change writes none; change and entry stand or fall together; no secrets; administrators only |
| Retries | Key required; repeat returns the same record; five simultaneous; different content refused; another person's key; revoked, missing and invented sessions get 401 and no data; same person after signing in again; record shown as it is now; membership ended gets 404; 23 hours remembered, 25 hours treated as new |
| Fixtures and production | Fixtures off means closed; migration role keeps data closed; unmarked and production-marked databases refuse fixtures; the mark cannot move back; loader safeguards one by one; production configuration refusals; production start refused, by starting it; no country, currency or time-zone names |

New browser checks, in each language: empty list, create form with the development-only label,
empty form (summary links to each field, focus on the summary, nothing created), draft kept
across a language change, create, the unverified-draft notice, change with the draft kept across
a language change, history present on the server, a save made stale by a change elsewhere
(refused, nothing overwritten, current values shown), and the list after a fresh load. Once:
another person's organisation and a missing one both answer 404; a create and a save whose
answers are lost show "not confirmed", and the retry ends in the true state with no duplicate.
Seven screen states x 3 languages, plus one, are checked at four widths, with text doubled, and
with axe-core: 0 violations.

## 5. Design defects found on the real screens and fixed

- The draft of a change was lost on a language change after a save or create; fixed and checked.
- The link back to the list was under 24 px high; it is now a button.
- The form for changing a draft showed stale values after someone else saved; it now shows the
  current values and says the change was not saved.

## 6. Changes to set-up

- The migration role needs `CREATEROLE`: the migrations create `trucker_app`. A role made
  earlier needs `ALTER ROLE trucker CREATEROLE` once, as `postgres`. Windows instructions and
  the Windows CI job are updated.
- The API should be given `APP_DATABASE_URL`. `.env.example` holds the local value;
  `npm run db:app-role` creates the login. Without it organisation data stays closed.
- Production configuration now also requires `APP_DATABASE_URL`, `ORGANISATION_CREATION_LIMIT`
  and `RETRY_KEY_RETENTION_HOURS`, and a database marked production.

## 7. Limits and what is not claimed

- **Identity tables are not under row security.** The API's role can read and insert session
  rows. The person check stops forged identifiers; it would not stop someone who had taken over
  the API's role entirely. Follow-up: move session handling into database functions.
- The database judges a session by revocation and its absolute end. The idle limit is applied
  by the API, which revokes the session when it sees it.
- Nothing can change an organisation without a signed-in person. Staff and system changes need
  their own path later. The test that needs a non-draft organisation switches the audit trigger
  off for one statement, as the table's owner.
- The 403 answer for a member who is not an administrator is not reached by any test: no such
  role exists.
- In the browser, the closed-registration page and the creation-limit message are not
  exercised; the API tests cover both rules.
- Expired retry keys are removed only when the same key is used again. No clean-up job exists.
- The name check (CC-9) covers the migrations, the organisation code, the access and local
  helpers and the fixture file, not the whole repository.
- Not checked: physical phones, Safari, Firefox, screen readers, native-reader review of
  Arabic and Urdu. No accessibility conformance is claimed.
- The one unexplained API test failure recorded in slice 4 did not recur.

## 8. Documentation to align once pull request #4 is merged

This pull request does not edit files changed by #4. Due afterwards, in addition to the list in
`REGISTRATION_SLICE_4.md` section 10:

| File | Edit |
|---|---|
| `docs/specs/STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md` | J1.2: duplicate registration numbers are allowed in drafts and resolved at verification (O-1), replacing "unique per country" and "request to join". REQ-ORG-01 partly implemented (draft only, shipper only). REQ-PRM-01 partly implemented (organisation isolation) |
| `docs/specs/STAGE_3_ARCHITECTURE.md` | T-001 condition met for organisation tables: a non-bypass API role, tested |
| `docs/delivery/STATUS.md` | Add slices 3, 4 and 5 |

## 9. Needs Abdullah

1. Review of this pull request. It is not merged.
2. Production review of the creation limit and the retry-key retention period.
3. Whether to close the identity-table limit (section 7) before or after the shipment slice.
