# Trucker: organisation onboarding slice — scope and acceptance criteria (approved)

Version 1.0, 13 November 2026. Owner: Abdullah.

**Status: scope approved by Abdullah on 13 November 2026, with decisions O-1 to O-4 and three
instructions to strengthen the criteria (section 2).** The build is in the pull request recorded
in `docs/delivery/ORGANISATION_ONBOARDING_SLICE_5.md`; this document is the standard it is
measured against. Approval of the scope is not approval of the pull request.

Repository copy: `docs/delivery/ORGANISATION_ONBOARDING_SLICE_5_SCOPE.md`. Version 0.1 (the
proposal) is superseded by this one.

## 1. The journey

A registered person creates a shipper organisation, becomes its first administrator, and can
see and correct its details. The organisation is a draft: it is not verified and can do nothing
commercial. Screens: B-01 organisation onboarding, part of X-07 (the account page links to the
person's organisations) and part of X-09 (choosing which organisation to act for). English,
Arabic and Urdu, with right-to-left layout.

## 2. Decisions

### 2.1 Given with the approval (13 November 2026)

| # | Decision | Effect |
|---|---|---|
| O-1 | Duplicate registration numbers are allowed in drafts. A draft grants no ownership or commercial right; verification must resolve competing claims | No uniqueness rule on registration number. The page says what a draft does not give |
| O-2 | Shipper only for this slice | Requested capability is `ship`; nothing else can be requested or granted |
| O-3 | Recheck and merge #5, then #6, watching CI after each; stop on failure or substantive conflict; leave #4 and `main` untouched | Done before the build; the slice starts from updated `staging` |
| O-4 | Several organisations per person, with a configurable development limit of five creations; production requires an explicitly reviewed limit | `ORGANISATION_CREATION_LIMIT`, default 5 outside production; production refuses to start without it |
| S-1 | Database isolation must check authenticated membership, not merely trust the selected organisation identifier. Test forged context, cross-person access, organisation creation and organisation listing | Section 4.2 |
| S-2 | Authenticate and authorise before returning stored retry results. Define retry retention and test retries after session revocation | Section 4.4 |
| S-3 | Local fixture activation must have enforceable environment safeguards; a production refusal alone is insufficient | Section 4.5 |
| — | Keep the final-audit backlog and this scope under version control without overwriting pending changes. Defer wording and translation corrections to the audit stage | Both are in `docs/delivery/`; no file of pull request #4 is touched |

### 2.2 Earlier decisions this scope rests on

| Decision | Effect on this slice |
|---|---|
| Small, complete journeys with real UI, API, database, permissions and tests | Delivered together in one pull request |
| The six GCC countries are the target; launch countries are a separate, open decision | No real country is enabled |
| Fictional countries are isolated test fixtures, never seeded as approved production configuration | No country data ships |
| D-001 and D-002 stay open | No contract, credit, supplier, payout or bank fields |
| Permission boundaries need approved rules and tests, not configuration | Permissions are fixed rules in the database, with tests |
| T-001: row security only after testing with a role that cannot bypass it | The API gets its own database role; the tests use it |
| Capabilities are granted only by a compliance decision | Only the request is recorded |

## 3. Scope

| In scope | Out of scope |
|---|---|
| Create a draft organisation: legal name, trading name (optional), country of registration, registration number, address (optional), contact person (optional) | Verification: documents, upload, staff queue, decisions |
| The creator becomes the first administrator | Granting any capability; publishing; anything a carrier sees |
| View and change the organisation while it is a draft | Submitting for verification; the declaration of authority to bind the organisation |
| List the person's organisations; choose one by opening it | Invitations, further members, other roles |
| The database decides who is asking and whether they are a member | Staff accounts and the operations console |
| Audit entry for every change, written by the database in the same transaction | Closing or deleting an organisation; draft expiry |
| Safe retries on create | Locations, shipment drafts (next slice) |
| Production closed: no approved country, so creation is refused | Tax, billing, bank or payout details |

## 4. Acceptance criteria

Each criterion is proved by an automated test against a real PostgreSQL database, in CI. A
criterion without a passing test is not done.

### 4.1 Organisation and membership

| ID | Criterion |
|---|---|
| ORG-1 | A signed-in person who has completed registration can create an organisation. Anyone else cannot |
| ORG-2 | The organisation, its first administrator and the audit entry are written in one transaction: all exist or none does. A test forces a failure part-way and finds nothing left behind |
| ORG-3 | A new organisation is a draft with a requested capability and no granted one. Nothing in this slice can grant one or change the status |
| ORG-4 | Legal name, country and registration number are required. Missing or malformed values are refused, each field is named, nothing is saved |
| ORG-5 | The country must be open for registration. With no open country, creation is refused with `organisation_registration_closed` |
| ORG-6 | The person's mobile number plays no part in the organisation's country |
| ORG-7 | Only an administrator can change an organisation, and only while it is a draft. The database refuses it too |
| ORG-8 | Two saves from the same version cannot both succeed: the second is refused and given the current values |
| ORG-9 | An organisation always has an administrator: nothing can remove or end a membership in this slice, in the API or as the API's database role |
| ORG-10 | Names and addresses are stored and returned exactly as typed, in any script |
| ORG-11 | (O-1) The same registration number may be used on several drafts, by one person or several. A response never shows any detail of another organisation |
| ORG-12 | (O-4) One person may create five organisations by default and no more. The limit holds under simultaneous requests. Production does not start without an explicit limit |

### 4.2 Isolation between organisations (strengthened: S-1)

The database, not the API, decides who is asking. The API passes the hash of the session token;
the database finds the live session and its person itself, and checks membership itself. An
identifier supplied by the API, for a person or an organisation, selects nothing on its own.

| ID | Criterion |
|---|---|
| TI-1 | The API's database role owns nothing, is not a superuser and has no right to bypass row security. It cannot disable, alter, drop or add a policy, replace or drop the functions the policies use, disable the audit trigger, create objects, or become another role. Each refusal is tested |
| TI-2 | Every table in the schema carries row security and a policy unless it is on a short named list of tables that hold no organisation data. The list of tables is read from the database catalogue, so a new table without a policy fails CI |
| TI-3 | Without a request context the API's role sees no row of any organisation table |
| TI-4 | **Forged organisation.** A real session that names another person's organisation as the one it acts for reads nothing, changes nothing and sees none of its history |
| TI-5 | **Forged person.** No session, an invented session, or a revoked session, together with a real organisation identifier, reads nothing. Settings the policies do not read change nothing |
| TI-6 | **Creation.** An organisation can be created only through one database function, which itself establishes who is asking. The API's role cannot insert an organisation, a membership or an audit entry directly, and the function refuses a forged or revoked session |
| TI-7 | **Listing.** A person lists exactly the organisations they are a member of. A member of two sees both; when a membership ends, that organisation disappears at the next request |
| TI-8 | **Cross-person.** Asking for an organisation the person does not belong to answers exactly as for one that does not exist, for read, change and history, in the API and in the web application |
| TI-9 | Context is set per transaction and gone at its end. Tests reuse one pooled connection across different people, after a refused request, after a failed one, after a rollback and after a statement timeout, and nothing carries over |
| TI-10 | Ending a session ends organisation access at the next request, in the API and in the database |
| TI-11 | If the API is connected with a role that row security does not bind, organisation endpoints stay closed (`organisation_access_closed`) in every environment, and production does not start |

### 4.3 Audit history

| ID | Criterion |
|---|---|
| AU-1 | Every create and change writes one entry in the same transaction: who, which organisation, what, which record, when (UTC), the request identifier, and the values before and after |
| AU-2 | A change and its entry stand or fall together: if the transaction fails neither remains; if the entry cannot be written the change is refused. The entry is written by a database trigger, so no code path can skip it |
| AU-3 | The API's role cannot insert, change, delete or truncate entries |
| AU-4 | Entries hold no session token, no hash of one, and no phone number |
| AU-5 | An administrator can read their own organisation's history and nobody else's |

### 4.4 Safe retries (strengthened: S-2)

| ID | Criterion |
|---|---|
| SR-1 | Creating an organisation requires a retry key supplied by the client |
| SR-2 | **Authentication first.** The session is checked before anything else: a revoked, expired, missing or invented session gets `401` and no stored result, whatever key it sends |
| SR-3 | **Authorisation second.** A stored key holds only a reference to the record it produced, never a copy of an answer. A retry is answered by reading that record through the same access rules as any read. A person who is no longer a member gets `404` and nothing else |
| SR-4 | The same key with the same content returns the same organisation and creates nothing new, including after the person signs in again, and it shows the record as it is now |
| SR-5 | The same key with different content is refused |
| SR-6 | A key belongs to the person who used it. Another person sending the same key learns nothing and gets their own result |
| SR-7 | Identical requests at the same moment create one organisation |
| SR-8 | A request refused for invalid input is not remembered; correcting it and sending the same key succeeds |
| SR-9 | **Retention.** A key is remembered for `RETRY_KEY_RETENTION_HOURS`, 24 by default. After that the same key is treated as new. Production must set the period explicitly |

### 4.5 Country data, fixtures and production (strengthened: S-3)

Fixtures are kept out of production by several independent barriers, three of them enforced by
the database itself.

| ID | Criterion |
|---|---|
| CC-1 | No country ships. The register is empty after the migrations |
| CC-2 | **Database mark.** Each database carries one mark: unmarked, local-development, test or production. A fixture country is refused by the database unless the mark is local-development or test |
| CC-3 | **One-way.** A production mark can never be changed or removed; a marked database cannot be unmarked; a database holding fixtures cannot be marked production |
| CC-4 | **Private-use codes.** A fixture must use a country code reserved for private use, and such a code can never be entered as a real country. Both are database constraints |
| CC-5 | **Loader.** The fixture loader refuses to act unless all hold: `NODE_ENV` is development or test, an exact acknowledgement is set, and the database is on this machine. It also refuses a database marked production |
| CC-6 | **API.** The API counts fixture countries as open only when its own setting is on, which production configuration refuses and which needs a database on this machine, and only when the database is marked local-development or test. The database function applies the same mark check itself |
| CC-7 | **Production start.** A production API does not start unless the database is marked production and the API's role is bound by row security. Tested by starting it |
| CC-8 | The API's role cannot write countries or the mark |
| CC-9 | No country, currency or time-zone name appears in the migrations or the organisation code; fixture data uses only private-use codes. A test searches for them |

### 4.6 Screens

| ID | Criterion |
|---|---|
| UI-1 | The journey runs in a real browser against the real API and database in English, Arabic and Urdu: create, see, change, reload, and it is still there |
| UI-2 | A refused form keeps what was typed, moves focus to an error summary, and the summary links to each field |
| UI-3 | A started form, for creating and for changing, survives a change of language |
| UI-4 | The page states that the organisation is an unverified draft and what it cannot do. Status is never shown by colour alone |
| UI-5 | Each screen state is checked at 320, 390, 768 and 1280 px and with text size doubled |
| UI-6 | Automated accessibility rules report no violations on each state. Not a conformance claim |
| UI-7 | When an answer is lost, the page says the outcome is not confirmed, never that it succeeded or failed. Trying again ends in the true state and makes no duplicate |
| UI-8 | A person with no organisation is led to create one; the organisation in use is named at the top of its page |
| UI-9 | Fictional countries are labelled on the form as development-only test data |

### 4.7 Evidence for "done"

| ID | Criterion |
|---|---|
| EV-1 | All three CI jobs pass on the pull request |
| EV-2 | The pull request states what was run, with counts, and what was not verified |
| EV-3 | Nothing is simulated silently |
| EV-4 | Requirements, design notes, the coverage matrix and the final-audit backlog are updated, without touching pull request #4's files |
| EV-5 | At most five screenshots, reviewed, with design defects found on the real screens fixed and listed |

## 5. Known limits accepted for this slice

- Identity tables (people, sessions, sign-in codes) are not under row security. The API's role
  can read and insert session rows, so the person check stops forged identifiers but would not
  stop someone who had taken over the API's role entirely. Closing that needs session handling
  to move into database functions; it is listed as follow-up work.
- Nothing can change an organisation without a signed-in person behind it. Staff and system
  changes (verification, suspension) need their own path in a later slice.
- No message supplier, no account recovery, no verification: nobody can do anything commercial.
