# Trucker: security backlog

Version 0.1, 14 November 2026. Owner: Abdullah.

Security defects are normally fixed in the slice where they are found. This list holds the ones recorded for a later, deliberate fix by decision, and the open production gates, so that neither is lost. An entry leaves only when it is fixed and its acceptance test passes, or when Abdullah decides otherwise.

## 1. Open defects

### SEC-01: nothing enforces that an administrator remains when administrators act on each other at the same moment

**Status:** open. **Must be resolved before production and before any real staff use** (Abdullah, 14 November 2026). Development continues with test accounts only. The administrator-independence rule (nobody acts on their own account) is not to be weakened to fix it.

**Where:** `db/migrations/0006_staff_identity.sql`, functions `staff_set_privilege` and `staff_set_status` (slice 8, merged as `074e068`).

**The defect.** Each function checks that the caller is an administrator and is not acting on themselves, then makes the change. Two administrators can each pass that check at the same moment and then each remove the other's `staff_admin` privilege, or each disable the other. The functions take no lock that orders the two requests against each other, and neither checks afterwards that an active administrator still exists. The design therefore does not guarantee that one remains. With no administrator, nobody can grant privileges, re-enable an account or issue an enrolment link, and the operator command would have to be used again, which is exactly the situation it is meant to be needed for only once.

**Reproduction (verified on 14 November 2026, on the merged code).** Test `SEC-01` in `apps/api/src/staff/staff.test.ts`:

1. Two enrolled administrators, A and B, each signed in. No other administrator.
2. A second database connection holds `LOCK TABLE trucker.staff_privilege IN SHARE MODE`, so that reads pass and removals wait.
3. A asks to remove `staff_admin` from B. B asks to remove it from A. Both requests pass their checks and wait at the removal.
4. The lock is released.

**What happens today, as observed.** One removal succeeds. The other request is aborted by PostgreSQL's deadlock detector after about a second and answers **500 internal_error**. One administrator is left.

That outcome is an accident, not a rule. Writing the audit entry makes each request take a key lock on the other's account row, which the other request already holds, and the database breaks the tie by killing one of them. If the audit entry, its foreign keys or the order of statements changed, both removals would succeed and no administrator would remain. And even now the person whose request is killed sees a server error instead of a clear refusal.

**Not verified, inferred from reading the code:** the same holds for two administrators disabling each other (the wait there is on each other's session rows), and for one disabling while the other removes the privilege. These need their own tests with the fix.

**Required fix.**

1. Order all changes to who is an administrator: every call of `staff_set_privilege` and `staff_set_status` takes one shared advisory lock before it reads anything, so that two such changes never run at once.
2. Enforce the rule itself: after the change, inside the same transaction, at least one account that is active, enrolled and holds `staff_admin` must remain. If not, the change is undone and the function answers `last_administrator`.
3. Re-read the caller's privilege after the lock is taken, so that a caller who lost `staff_admin` while waiting is refused as not holding it.
4. The API answers 409 with a clear code for both refusals. No request may end in a deadlock abort.
5. A new forward migration; `0006` is merged and is not edited.

**Acceptance tests.**

| ID | Test |
|---|---|
| SEC-01-a | Two administrators remove each other's `staff_admin` at the same moment: exactly one succeeds, the other is refused with 409, no request answers 500, one active administrator remains. This is the existing `SEC-01` test, with its "todo" mark removed |
| SEC-01-b | The same with two administrators disabling each other |
| SEC-01-c | The same with one disabling and the other removing the privilege |
| SEC-01-d | Three administrators acting in a ring (A on B, B on C, C on A): at least one remains, no 500 |
| SEC-01-e | The refusals are audited. The refused caller's session and privileges are unchanged |
| SEC-01-f | Removing the fix (the lock, or the check) makes at least one of these tests fail |

## 2. Open production gates (not defects; listed so they are seen together)

| Gate | State |
|---|---|
| Encrypted connection between the API and the database | Enforced at production start |
| Statement parameters kept out of the database log | Enforced for ordinary statements; the limit for failed statements can be changed by the API's role and is still open |
| Certificate validation for the database connection | Not enforced |
| Connection pooler between the API and the database | Not covered by the checks |
| Protected settings reviewed for production | Enforced at production start; currently all development defaults |
| Staff console: network restriction and a content security policy | Not built; hosting undecided |
| Staff sign-in: limit per network address | Not built; locking is per account |
| Exceptional recovery of a sole staff administrator | Not built; needs separate explicit authorisation |
| Message supplier for participant sign-in codes | Not chosen; production sign-in is closed |
| Approved legal terms | Do not exist; production registration is closed |
| Real evidence requirements, document storage and document checking | Do not exist; verification is demonstration only and never allows production publication or discovery |
| Retention of the carrier access log (`carrier_access_log`) | **Unresolved production requirement.** The log is append-only and staff-only; how long entries are kept, and how they are removed after that, is not decided. Nothing removes them now |
| Discovery page size, read limit and cursor lifetime | Development defaults (20, 120 per minute, 2 hours); need production review with the other settings |
