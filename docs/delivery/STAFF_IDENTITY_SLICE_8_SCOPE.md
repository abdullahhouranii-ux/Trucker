# Trucker: staff identity and console slice, scope and acceptance criteria

Version 1.0, 14 November 2026. Status: **approved by Abdullah on 14 November 2026**, as the first of two verification slices, with decisions S-1 to S-4. Record of what was built: `STAFF_IDENTITY_SLICE_8.md`. The second slice (organisation verification) has its own scope.

## 1. What this slice is

A staff member signs in to a separate console with a mandatory second factor, sees only what their privileges allow, and every action they take is recorded. No verification screen or decision is part of it.

## 2. Decisions

| ID | Decision |
|---|---|
| S-1 | Work email and password, a mandatory authenticator-app code, and single-use recovery codes. Established security libraries are used |
| S-2 | A one-time, audited operator command creates the first administrator, with an expiring, single-use enrolment link. It never resets an existing administrator automatically. Recovery uses recovery codes. Exceptional operator recovery needs separate explicit authorisation and is not built |
| S-3 | A staff administrator may grant the reviewer privilege to another person, never to themselves. Grants, removals and refusals are audited |
| S-4 | Whether a staff member also has a participant account is a declared link, with a conflict declaration at each decision (slice 9). Missing information never means "independent": an explicit declaration is recorded and its changes are audited |

## 3. In

1. Staff accounts, separate from participant accounts. A participant session is never a staff session and the reverse.
2. A separate application, `apps/console`, on its own address. English only for now: the language staff work in is not decided.
3. Sign-in in two steps: email and password, then an authenticator code or a recovery code. No staff session exists without both. No setting makes the second step optional.
4. Enrolment by link: the holder sets a password, adds the authenticator and proves it works. Recovery codes are shown once.
5. Privileges per account: `staff_admin` and `reviewer`. In this slice `reviewer` grants nothing yet. No privilege implies another.
6. Every request is authorised by the API and again by the database. The console is not a security boundary (T-003).
7. An audit entry for every staff action and for every refused attempt to use a privilege not held.
8. Staff sessions with idle and absolute limits from the protected settings, judged with the database's clock after any lock wait.
9. Console screens: sign in, code, enrolment, own account and sign out, staff accounts (add, grant, remove, disable, enable, new enrolment link, declaration), audit list.

## 4. Out

| Out | Reason |
|---|---|
| Any verification screen or decision | Slice 9 |
| Compliance, finance, support and operations privileges | Added with the features that need them |
| Two-person approval | Mandatory for financial changes; built with them |
| Changing one's own password or authenticator while signed in | A new enrolment link from another administrator covers it; self-service is a later improvement |
| Exceptional recovery of a sole administrator who lost everything | Needs separate explicit authorisation (S-2) |
| Single sign-on with an external provider | A supplier choice |
| Network restrictions on the console in production | Hosting undecided. A production gate, not built |

## 5. Acceptance criteria

| ID | Criterion |
|---|---|
| STF-1 | No staff session is created without both factors. Tested at the API and by direct calls as the API's database role |
| STF-2 | A participant token is refused by every staff route and function; a staff token by every participant route and function |
| STF-3 | Passwords, authenticator secrets and recovery codes cannot be read by the API's database role. A code is single-use; a replayed code is refused |
| STF-4 | Wrong passwords and codes are limited from protected settings. The caller cannot loosen them |
| STF-5 | Without `staff_admin` no staff account or privilege can be created, disabled or changed. Refused attempts are audited |
| STF-6 | Nobody can grant themselves a privilege, remove their own, or disable themselves; so the last administrator cannot be removed |
| STF-7 | Disabling an account ends its sessions at the next request |
| STF-8 | Every staff action leaves exactly one audit entry. Entries cannot be changed or deleted |
| STF-9 | Session expiry uses the database's clock, including for a request that waited behind a lock |
| STF-10 | Lost answers are reported as not confirmed. Asking again applies nothing twice |
| STF-11 | The console works by keyboard, passes the automated accessibility rules, and never shows status by colour alone |
| STF-12 | No configuration makes the second factor optional. Production does not start with development sign-in aids enabled or with the settings not reviewed; adding the staff settings withdraws any earlier review |

## 6. Carried forward, unchanged

- Production gates: encrypted database connection; parameter-log protection, with the failed-statement limit still open; certificate validation and pooler coverage, not enforced.
- Supplier delivery of participant sign-in codes: provisional.
- Staging CI diagnosis behind PR #9: inferred, not verified. Slice-4 unexplained test failure: unresolved.
- Development defaults needing production review: SD-5 limits, retry-key retention, and now the six staff settings.
- Wording and translation corrections: final-audit backlog.
