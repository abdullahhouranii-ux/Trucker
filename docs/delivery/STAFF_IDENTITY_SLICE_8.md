# Trucker: staff identity and console slice 8, record

Date: 14 November 2026. Branch `feat/staff-identity`, from staging at `9836610`. Scope and decisions: `STAFF_IDENTITY_SLICE_8_SCOPE.md`.

## 1. What was built

| Part | Where |
|---|---|
| Staff accounts, privileges, enrolment links, recovery codes, sign-in tickets, sessions, audit entries; six protected settings; the functions for all of it | `db/migrations/0006_staff_identity.sql` |
| API routes under `/staff` | `apps/api/src/staff/` |
| Operator command for the first administrator | `apps/api/src/cli/staff-bootstrap.ts`, `npm run staff:bootstrap` |
| The console: sign-in, code, enrolment, own account, staff accounts, audit | `apps/console/` |

## 2. How it works

**Two steps, always.** Email and password give a ticket that is valid for five minutes and opens nothing. The ticket plus a correct authenticator or recovery code gives the session. One database function creates staff sessions, and it checks the code first; a test reads the schema to hold that. There is no setting for it.

**Where secrets are checked.** Inside the database. The API's role cannot read any staff table. Passwords are hashed with bcrypt (pgcrypto, cost 12) after being keyed with a value only the API holds. Authenticator secrets are stored encrypted with that key. Recovery codes are stored as keyed hashes. So the tables alone yield no password, secret or code, and the API's database role alone cannot forge a session.

**Libraries.** pgcrypto, which ships with PostgreSQL, provides bcrypt, HMAC-SHA-1, encryption and random bytes. It lives in a schema the API's role cannot use. The authenticator arithmetic (RFC 6238, about fifteen lines on top of pgcrypto's HMAC) is in the migration; it is checked against the RFC's published values and, in every test, against otplib, an independent implementation that generates all the codes the tests type. The console draws the QR code with the `qrcode` package.

**Enrolment link.** Random, stored only as a hash, valid 24 hours by default, usable once, ended by five wrong codes. Its secret travels in the address fragment, which browsers do not send to servers, and then only in request bodies.

**First administrator (S-2).** `npm run staff:bootstrap -- <email> <name>` runs as the migration role, creates one invited administrator and prints the link once. It refuses when an enrolled, active administrator exists and changes nothing about anyone. Run again before enrolment, it replaces the link. Every run is audited, refused ones included.

**Privileges (S-3).** An administrator grants and removes for others only. The same holds for disabling, for a new enrolment link and for the declaration: nobody acts on their own account. The table itself also refuses a grant recorded as made by its holder.

**Declaration (S-4).** Creating an account requires stating either "has no participant account" or "has one, with this mobile number". The first administrator, made by the operator command, is recorded as "not declared", which is shown as not the same as having none. Changes are audited without the number.

**Refusals say nothing.** Sign-in answers the same for an unknown email, a wrong password, an account not set up, a disabled one and a locked one, and does the same work for each.

## 3. Checks run (local, this commit)

| Check | Result |
|---|---|
| `npm run verify` | Passed |
| API tests | 210 passed, 0 failed (188 before; 22 new for staff) |
| Web unit tests, tool tests | 24 and 9 passed |
| Web browser checks | 1,060 checks, 0 failed (unchanged code; run because the root command now builds three applications) |
| Console browser checks, real Chrome, real API, a database of their own | 128 checks, 0 failed |

CI results are in the pull request.

### Defect injection

Each defect was put into the migration, the staff tests run, and the migration restored (verified identical).

| Injected defect | Caught by |
|---|---|
| Sign-in does not check the code | five tests, first "a password alone opens nothing" |
| The privilege is not checked | "without staff_admin nothing can be administered" |
| Self-grant allowed | "never for themselves" |
| A disabled account keeps its session | "disabling an account ends its sessions" |
| A code is accepted twice | "a password alone opens nothing" |
| The operator command ignores an existing administrator | "refuses once an administrator is active" |
| Refusals not recorded | "every refusal is recorded" |
| No lock after wrong attempts | "lock the account for the protected period" |
| An expired ticket is accepted | "the step between password and code is short" |

One was **not** caught at first. The rule that a session of a disabled account is never live was hidden behind the function that also ends sessions when disabling. A test now disables an account directly, as the migration role, and checks the rule itself.

## 4. Screens reviewed and defects fixed

Five pictures (`apps/console/tests/output/`, not committed): authenticator step, recovery codes, staff accounts, the refusal shown to a person without the privilege, audit list.

| Defect found | Fix |
|---|---|
| Radio buttons for the declaration were smaller than the minimum target | Enlarged |
| Audit entries used definition terms outside a definition list | Proper list structure |
| Enrolment steps ran their heading, text and form together | Section spacing as elsewhere |

## 5. Known limits

1. **pgcrypto is required.** It ships with PostgreSQL and is a trusted extension, so the database owner can create it; a hosted database must offer it.
2. **Passwords and codes travel to the database as statement parameters.** The existing production gates (encrypted connection, no parameter logging) cover this; the failed-statement logging limit is still open, as before.
3. **Locking is per account.** There is no limit per network address, so someone can lock a known staff email out for the lock period by guessing. Decided against revealing less; a per-address limit belongs with the hosting decision.
4. **No password check against lists of breached passwords.** Length 12 to 128, and not the email. A breach list needs a data source.
5. **A staff member cannot change their own password or authenticator while signed in.** Another administrator issues a new enrolment link. Until that link is used, the old credentials keep working.
6. **A sole administrator who loses password or authenticator and all recovery codes cannot get back in.** Deliberate (S-2): exceptional recovery needs separate authorisation and is not built. Two administrators avoid it.
7. **The declaration cannot be recorded for the first administrator until a second administrator exists,** because nobody acts on their own account. Slice 9 will refuse review decisions from "not declared".
8. **Granting staff administrator is one click,** recorded and reversible by another administrator, with no second confirmation.
9. **The console sets no Content-Security-Policy.** It sets no-store, no-referrer, no framing and no indexing. Network restriction and a content policy are production gates for the hosting decision.
10. **English only.** No screen reader, physical device, Safari or Firefox test. No accessibility conformance is claimed.

## 6. Carried forward, unchanged

- Production gates: encrypted database connection; parameter-log protection, failed-statement limit open; certificate validation and pooler coverage, not enforced. Added for the console: network restriction and content policy.
- Supplier delivery of participant sign-in codes: provisional.
- Staging CI diagnosis behind PR #9: inferred. Slice-4 unexplained failure: unresolved.
- Development defaults needing production review now include: staff session idle 15 minutes and absolute 8 hours, 5 wrong attempts, 15-minute lock, 5-minute ticket, 24-hour enrolment link.

## 7. Needs Abdullah

1. Review and merge decision for the pull request. Nothing is merged or deployed.
2. Limit 7: the first administrator's declaration can only be recorded by a second administrator. If you will be the only staff member for a while, say so before slice 9 is merged, because a sole, undeclared administrator will not be able to review.
