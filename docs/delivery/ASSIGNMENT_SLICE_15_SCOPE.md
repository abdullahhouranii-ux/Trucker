# Trucker: assignment, reservation and confirmation slice 15, scope and acceptance criteria

Version 0.1, 15 November 2026. Status: **for approval. Nothing here is built.** The reservation model was approved on 15 November 2026 (RELEASE_1_DECISIONS.md, section 3); this scope applies it and lists the few decisions it still needs.

## 1. What this slice is

The carrier assigns a truck, a driver and, where needed, a trailer to a booking that is awaiting resources. Each assignment creates a **planned reservation** for the booking's planned interval. When every required resource is assigned, eligible for the whole interval and reserved, the booking becomes **confirmed**, and not before. The assigned driver acknowledges the assignment in their own account.

Occupancy is prepared here but not opened: an occupancy episode opens only at dispatch (slice 17). The tables and the rule "one open episode per resource, any number of closed ones" are built now so that reservation checks can read them.

## 2. Rules (already approved, restated)

| Rule | Definition |
|---|---|
| Planned reservation | One per resource per booking, for the half-open interval on the booking snapshot. The database refuses two active reservations of one resource that overlap |
| Occupancy episodes | A resource has many historical episodes and at most one open one. An episode opens at dispatch and closes only by an explicit release. No POD action closes one |
| Overrun | While an episode is open, the resource counts as taken until `greatest(planned end, now)`. A new reservation that would start before that is refused. A later booking already holding the resource is flagged, not cancelled |
| Assignment check | At assignment and at confirmation: slice 13 eligibility for the whole planned interval, operating control, equipment match, authorisation and licence class, and no overlap |
| Dispatch check | Separate, in slice 17, at its own moment: eligibility again, reservation still active, no open occupancy on any resource, acknowledgement |
| Confirmation | Derived, never set by hand: every required resource has an active reservation and passes the assignment check. If a resource later stops being eligible, the booking is shown as needing reassignment; it is not silently unconfirmed |

## 3. Out of this slice

Dispatch, opening or closing occupancy, release (17 and 18); cancellation charges (16); substitution rules after confirmation beyond "reassign before dispatch".

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| ASG-1 | Only the carrier's administrators assign, and only their own eligible resources. Each refusal names the first failing reason |
| ASG-2 | Two simultaneous assignments of one resource to overlapping intervals: exactly one succeeds. Intervals that touch both succeed (AT-231 to AT-233) |
| ASG-3 | A booking is confirmed only when every required resource is assigned, eligible for the whole interval and reserved, judged in the database at that moment |
| ASG-4 | A resource with an open occupancy episode past its planned end cannot be newly reserved for an interval starting before now |
| ASG-5 | A resource can hold many closed episodes and at most one open one, enforced by the database |
| ASG-6 | Reassignment before dispatch releases the old reservation and creates the new one in one transaction |
| ASG-7 | The driver sees and acknowledges their own assignment, and nothing of other bookings |
| ASG-8 | After the assignment deadline an unassigned booking is shown as overdue to both parties and in the operations queue; nothing is cancelled or reassigned automatically |
| ASG-9 | Recording nothing in this slice opens or closes occupancy; no POD field or route exists |
| ASG-10 | A consistency check reports nothing for a correct booking and reports each seeded violation (AT-234) |

## 5. Decisions needed (with recommendations)

| ID | Decision | Recommendation |
|---|---|---|
| AB-1 | What the carrier sees after acceptance | Shipper's name from acceptance (as built). Full addresses, access notes and site contacts only once the booking is confirmed, so they are not released to a carrier that never assigns resources |
| AB-2 | Which resources a booking requires | A truck and a driver always. A trailer when the assigned truck's category is a tractor unit. The category-to-trailer rule is a register, fictional in development |
| AB-3 | What the shipper sees of the assignment | Vehicle registration numbers and the driver's name once confirmed; never document numbers or the driver's phone until dispatch |
| AB-4 | After a missed assignment deadline (DB-7) | As proposed: the shipper may wait or cancel without charge; both are recorded; nothing automatic |
| AB-5 | Driver acknowledgement | Required before dispatch, not before confirmation, so a booking can be confirmed while the driver is off shift |
