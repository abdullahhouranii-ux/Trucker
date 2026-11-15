# Trucker: acceptance and booking slice 14, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **instructed by Abdullah on 15 November 2026 (13:15): prepare and implement against provisional settings.** Built on branch `feat/booking` (record: BOOKING_SLICE_14.md). Sources: `docs/specs/STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md` sections 6 and 7 (AT-221 to AT-225); RELEASE_1_DECISIONS.md.

## 1. What this slice is

The shipper's administrator accepts one exact version of one open quotation. In one transaction the quotation becomes accepted, the other open quotations are not selected, the shipment is awarded, and one booking is created with an immutable snapshot. The booking starts as **awaiting resources**. Both parties and staff can read it.

## 2. Conditions from the instruction

| ID | Condition |
|---|---|
| BC-1 | CC-1 to CC-6 are **development defaults only**: the shipper pays a 3% fee, rounded half-up; payment within 15 days; the proposed assignment deadline and buffers. Production approval is separate. CC-7 (geography) stays undecided |
| BC-2 | The booking keeps exact snapshots of the quotation version, the price, the fee and the terms |
| BC-3 | Acceptance is atomic, and retries create one booking |
| BC-4 | Short notice is explicit: if the calculated assignment deadline has already passed, acceptance is refused with a clear reason. An already-overdue booking is never created |
| BC-5 | A booking is not marked confirmed until every required, eligible resource is assigned and reserved. Assignment checks and dispatch checks stay separate. Neither is in this slice |

## 3. Out of this slice

Assignment, reservation, occupancy and confirmation (slice 15); cancellation (16); dispatch and trip (17); POD (18); invoices, payment records and reconciliation (19); any tax calculation or statement; shipper counter-offers; notifications.

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| BKG-1 | Only an administrator of the shipper accepts. The carrier, other organisations and outsiders are answered as for a missing record |
| BKG-2 | Acceptance names the quotation version. A stale version is refused and nothing is created (AT-223) |
| BKG-3 | The quotation is judged at the moment of acceptance, after the locks, by the database clock: open, current, not past its validity, carrier still eligible, shipment published and not suspended. An acceptance one second after validity is refused, also for a request that waited behind a lock (AT-222) |
| BKG-4 | Two simultaneous acceptances of different quotations leave exactly one booking; the other is refused as already awarded (AT-221). An acceptance racing a withdrawal leaves one consistent outcome and no server error |
| BKG-5 | A retried acceptance with the same key returns the same booking and creates nothing more (AT-224). The same key for a different request is refused |
| BKG-6 | The fee is the configured share of the transport price, rounded half-up to the currency's minor unit, calculated in exact decimals. The database refuses a booking whose fee is anything else. Amounts are text end to end |
| BKG-7 | The booking snapshot cannot be changed or removed, by anyone, and later changes to settings do not alter it (AT-225) |
| BKG-8 | If the assignment deadline calculated at acceptance has passed, acceptance is refused as `assignment_deadline_passed`, the shipper is shown this before trying, and the database itself refuses a booking that would start overdue |
| BKG-9 | No booking is confirmed, and no route assigns, reserves, confirms, cancels, invoices or pays |
| BKG-10 | Outside a database marked local-development or test, acceptance answers "closed". The API role reaches bookings only through functions |
| BKG-11 | Screens pass the existing browser checks in EN, AR and UR at phone widths with text doubled. A lost acceptance answer is checked: one booking, never reported as done unless confirmed |
