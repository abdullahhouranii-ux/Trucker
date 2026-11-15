# Trucker: assignment, reservation and confirmation slice 15, record

Date: 15 November 2026. Branch `feat/assignment`, stacked on `feat/booking` (PR #20), which is stacked on PRs #19, #18, #17, #16 and #15, all unmerged. Scope: ASSIGNMENT_SLICE_15_SCOPE.md.

Nothing is dispatched, occupied, released, cancelled, invoiced or paid. Every register and commercial value is a development default.

## What was built

| Part | What it does |
|---|---|
| Migration `0014_assignments.sql` | Assignments, planned reservations, the confirmation record, substitution proposals, acknowledgements, the wait decision, occupancy episodes and risk flags. The API role has no right on any of the tables |
| Required resources (AB-2) | A truck and a driver always; a trailer when the truck's category is marked as pulling one. The mark is a column of the fictional category register. Where a trailer is used it carries the shipment's equipment type |
| The command | The carrier sends the whole set it wants and the set number it saw. One transaction: locks (organisation, this booking's set, the resources in one order), then the clock, then the checks, then the change. Sending the set that already stands changes nothing, so a retry after a lost answer is safe without a retry key |
| Hard requirements (AC-2) | The slice 13 eligibility functions for the whole planned interval: ownership and operating control, suspension, documents, equipment type, the driver's affiliation, authorisation and licence class for the truck and for the trailer. The first failure is returned as a role and a reason. Nothing can waive them |
| Planned reservations (AC-6) | One per resource per booking for the half-open planned interval. An exclusion constraint refuses two active reservations of one resource that overlap, whoever writes them. A driver is reserved as a person, so a driver who changes carrier cannot be reserved twice |
| Confirmation | Written in the same transaction that completes the set: when, by whom, the set, and exactly what was released to the carrier. A trigger refuses any change. Nothing else can confirm a booking |
| Staged release (AB-1, AB-3, AC-1) | Carrier: addresses and access notes only from confirmation, read from the confirmation record. Shipper: registration numbers and the driver's name only from confirmation; never an identifier, a phone or a document. **No site contact is shown anywhere: shipments hold none** |
| Reassignment (AC-2, AC-3) | Before confirmation the carrier changes the set freely. From confirmation on a member can be replaced, not removed. A like-for-like vehicle or a change of driver takes effect at once: old members ended, their reservations released, new ones reserved and assigned, in one transaction. The booking row is never written, so the price cannot change |
| Materially different substitute | A truck or trailer of another category, or a trailer added or removed, after confirmation, is a proposal. The substitute is reserved as "proposed substitute" so it cannot be booked elsewhere; the current set stays. The shipper accepts or declines; the carrier may withdraw. At acceptance the hard requirements run again: a substitute that fails them ends the proposal and cannot be accepted |
| Acknowledgement (AB-5, AC-4, AC-7) | The assigned driver, while affiliated with the booking's carrier, acknowledges one numbered set. Every change of the set raises the number, so the earlier acknowledgement no longer stands. Not needed for confirmation; needed for dispatch readiness |
| Readiness, separate from confirmation (AC-5) | A function lists what blocks dispatch now: not confirmed, a resource that fails a hard requirement (needs reassignment), a resource occupied by another booking, a resource overrunning, acknowledgement missing. It reads the confirmation and never changes it. Slice 17 will refuse dispatch on the same list |
| Lost eligibility (AC-5) | The booking stays confirmed, shows "needs reassignment" to both parties and in the operations queue, and is not ready. The shipper is told that, not which resource or why. Nothing is cancelled or released |
| Occupancy and overrun (AC-6) | The episode table with a unique index: any number of closed episodes, one open, per resource. A resource whose episode is open past its planned end counts as taken until now: a new reservation starting earlier is refused as `occupied`. A later booking holding it is flagged at risk once per episode, and the overrun is marked once on the reservation. Nothing in this slice writes an episode |
| Missed deadline (AB-4, AC-8) | Both parties and the operations queue see the booking as overdue. Only the shipper records a decision to wait, once; a table constraint refuses one dated before the deadline. It changes nothing else. The carrier can still assign |
| Consistency check (AT-234) | Reports a confirmed booking missing a required member, a member without its reservation, a reservation without a member, a proposed reservation without an open proposal, and an open occupancy without an active reservation |
| Web | A page for each booking: state, readiness, resources, the assignment form (a resource that cannot be chosen is listed with its reason), site details from confirmation, the substitution and its decision, the shipper's wait. The driver's page lists their assignments with the acknowledgement. EN, AR and UR (AR and UR drafts, TR-21) |
| Console | A read-only page of bookings needing attention with the consistency check; the shipment page shows the assignment and readiness |

## Choices made within the approved scope, for confirmation

| ID | Choice | Why |
|---|---|---|
| N-1 | "Materially different" means a vehicle of another category, or a trailer added or removed. A same-category vehicle and a change of driver take effect at once and are shown to the shipper | The specification's "like-for-like" is the same equipment and trailer type; the equipment type cannot differ because it is a hard requirement, and vehicles record no capacity. P-205 (when consent is needed for like-for-like) was never decided |
| N-2 | Every change of the set ends the acknowledgement, not only a change of driver | The driver acknowledged a set that named the vehicles |
| N-3 | A proposal has no deadline: it stays open until decided or withdrawn | The proposal cut-off and response period are operating parameters that were never approved |
| N-4 | The carrier may still assign after the deadline | Nothing is automatic, and refusing would be a consequence nobody approved |
| N-5 | The driver sees areas, windows, cargo and vehicles before dispatch: no address and no price | Addresses for the driver belong to dispatch |
| N-6 | An overrun and an at-risk flag are recorded on their own rows, not in the participant history | The history requires a person as actor; the clock is not one |

## A defect found in earlier work, and fixed (migration 0015)

The first CI run of this branch failed one staff-identity test in all three jobs, and the failure then reproduced locally. It was investigated, not retried.

| Item | Finding |
|---|---|
| Symptom | Completing a staff enrolment with a value that is not an authenticator code returned an unexpected error (500) instead of "wrong code" |
| Cause (verified) | `staff_enrol_complete` in migration 0006 (slice 8, merged) tests a field of an untyped record that it leaves unassigned for a malformed value. PostgreSQL cannot plan that test while the record is unassigned. It fails on the first call of a database session and after the session's cached plans are reset. Reproduced in an empty database with four lines of PL/pgSQL, with no Trucker code involved |
| Effect | An unexpected error to the caller, and the failed attempt was not counted towards the limit that ends an enrolment link. No credential was accepted or exposed |
| Why it appeared now (**inferred, not verified**) | A session that had already checked a well-shaped code kept a working plan, which hid it. With migration 0014 in place that plan was no longer there at the moment of the test: the failure is reproducible with 0014 and absent without it. The likeliest mechanism is that the larger migration set, run for a scratch database in the same test file, overflows PostgreSQL's invalidation queue and resets idle sessions' plans. That mechanism was not measured |
| Fix | Migration `0015_staff_enrol_complete_malformed_code.sql` replaces the function with the same logic, keeping the outcome of the check in two typed variables. Nothing else about enrolment changes |
| Test | A new staff test calls the function with malformed values as the first statement of a new session and again after `DISCARD PLANS`, checks that each is refused and counted, and that the right code still completes the enrolment. Without 0015 that test and the original one fail; with it both pass |

## Evidence

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 313 pass, 0 fail, 0 todo; web 24; console 9 (with migration 0015) |
| Assignment API tests | 9 tests, all pass: confirmation and staged release; every hard requirement; two races and touching intervals; substitution rules including a race between acceptance and withdrawal; lost eligibility; the driver; the missed deadline; occupancy and overrun; the consistency check and the API role |
| Deliberate defects in 0014, each caught | 18 of 18: the exclusion constraint removed; the availability pre-check removed (the constraint still refuses); confirmed without the trailer; a hard requirement waived; no shipper consent for a different set; acceptance without the re-check; an acknowledgement surviving a change; lost eligibility unconfirming; overrun ignored; two open episodes allowed; the shipper told why; resources shown to the shipper early; addresses shown to the carrier early; a wait before the deadline; any carrier assigning; removal after confirmation; a driver seeing other assignments; the confirmation editable. Migration restored, byte-identical |
| Web browser checks | All passed, including 11 assignment checks and a lost assignment answer leaving one confirmation and two reservations; three languages with text doubled |
| Console browser checks | All passed, including the bookings page |

## Not covered or still open

- Dispatch, opening and closing occupancy, release: slices 17 and 18. The overrun protections are tested with episodes written by the migration role.
- Cancellation: CANCELLATION_SLICE_16_SCOPE.md, for approval.
- No notification exists: a proposal, a decision or a lost eligibility is seen on the pages, not sent.
- Vehicles record no capacity or dimensions, so those hard requirements of the specification cannot be checked yet.
- Site contacts are not collected; showing them needs its own feature and privacy rules.
- Real document, licence and category registers, and the real meaning of "pulls a trailer" (X-5).
