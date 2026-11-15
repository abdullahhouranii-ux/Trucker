# Trucker: assignment, reservation and confirmation slice 15, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **approved by Abdullah on 15 November 2026 (14:23), with AB-1 to AB-5 as recommended and the conditions in section 2.** Built on branch `feat/assignment` (record: ASSIGNMENT_SLICE_15.md). The reservation model was approved earlier the same day (RELEASE_1_DECISIONS.md, section 3).

## 1. What this slice is

The carrier assigns a truck, a driver and, where needed, a trailer to a booking that is awaiting resources. Each assigned resource holds a **planned reservation** for the booking's planned interval. When every required resource is assigned, eligible for the whole interval and reserved, the booking becomes **confirmed**, and not before. The assigned driver acknowledges the assignment in their own account.

Occupancy is prepared here but not opened: an occupancy episode opens only at dispatch (slice 17). The table and the rule "one open episode per resource, any number of closed ones" are built now so that the reservation checks and the dispatch-readiness check can read them.

## 2. Conditions of the approval

| ID | Condition |
|---|---|
| AC-1 | Operational details are revealed only to authorised parties at the approved stage. Site contacts are shown only when that feature and its privacy rules are approved. A missing contact is never invented |
| AC-2 | Reassignment follows the existing substitution rules: hard requirements cannot be waived, the price cannot change, and a materially different substitute requires the shipper's acceptance |
| AC-3 | The old assignment stays until its replacement and reservations commit atomically |
| AC-4 | A driver change invalidates the previous acknowledgement |
| AC-5 | Historical confirmation is separate from current dispatch readiness. Lost eligibility visibly blocks dispatch and requires reassignment. It does not silently cancel the booking |
| AC-6 | The approved reservation, occupancy and overrun protections are built with concurrency tests |
| AC-7 | Driver acknowledgement is required before dispatch |
| AC-8 | After a missed assignment deadline the shipper's explicit decision to wait is recorded. Cancellation without charge belongs in slice 16. Nothing happens automatically |

## 3. Decisions approved as recommended

| ID | Decision | Approved rule |
|---|---|---|
| AB-1 | What the carrier sees after acceptance | The shipper's name from acceptance. Full addresses and access notes only once the booking is confirmed. Site contacts: not shown (AC-1) |
| AB-2 | Which resources a booking requires | A truck and a driver always. A trailer when the assigned truck's category is one that pulls a trailer. The category-to-trailer rule is a register, fictional in development |
| AB-3 | What the shipper sees of the assignment | Vehicle registration numbers and the driver's name once confirmed. Never document numbers or the driver's phone |
| AB-4 | After a missed assignment deadline | The shipper's decision to wait is recorded (AC-8). Nothing automatic |
| AB-5 | Driver acknowledgement | Required before dispatch, not before confirmation |

## 4. Rules

| Rule | Definition |
|---|---|
| Planned reservation | One per resource per booking, for the half-open interval on the booking snapshot. The database refuses two active reservations of one resource that overlap |
| Occupancy episodes | A resource has many historical episodes and at most one open one. An episode opens at dispatch and closes only by an explicit release. No POD action closes one |
| Overrun | While an episode is open, the resource counts as taken until `greatest(planned end, now)`. A new reservation that would start before that is refused. A later booking already holding the resource is flagged, not cancelled |
| Assignment check | At every change of the set: slice 13 eligibility for the whole planned interval, operating control, equipment match, authorisation and licence class, and no overlap |
| Dispatch check | Separate, judged whenever asked and enforced by slice 17 at its own moment: confirmed, every resource still eligible, no resource occupied elsewhere, acknowledgement given |
| Confirmation | Recorded once, in the transaction that completes the set, and never changed. If a resource later stops being eligible, the booking is shown as needing reassignment; it stays confirmed |
| Substitution after confirmation | Like-for-like takes effect at once. Materially different is a proposal: the substitute is held, the current set stays, and the shipper accepts or declines |

## 5. Out of this slice

Dispatch, opening or closing occupancy, release (17 and 18); cancellation (16); deadlines for substitution proposals; notifications.

## 6. Acceptance criteria

| ID | Criterion |
|---|---|
| ASG-1 | Only the carrier's administrators assign, and only their own eligible resources. Each refusal names the role and the first failing reason, and changes nothing |
| ASG-2 | Two simultaneous assignments of one resource to overlapping intervals: exactly one succeeds. Intervals that touch both succeed (AT-231 to AT-233) |
| ASG-3 | A booking is confirmed only when every required resource is assigned, eligible for the whole interval and reserved, judged in the database at that moment |
| ASG-4 | A resource with an open occupancy episode past its planned end cannot be newly reserved for an interval starting before now |
| ASG-5 | A resource can hold many closed episodes and at most one open one, enforced by the database |
| ASG-6 | Reassignment releases the old reservation and creates the new one in one transaction. After confirmation a materially different set takes effect only with the shipper's recorded acceptance, and a substitute failing a hard requirement cannot be accepted (AT-246, AT-247, AT-248, AT-255) |
| ASG-7 | The driver sees and acknowledges their own assignment, and nothing of other bookings. Any change of the set ends the acknowledgement |
| ASG-8 | After the assignment deadline an unassigned booking is shown as overdue to both parties and in the operations queue. The shipper's decision to wait is recorded. Nothing is cancelled or reassigned automatically |
| ASG-9 | Nothing in this slice opens or closes occupancy; no POD field or route exists |
| ASG-10 | A consistency check reports nothing for a correct booking and reports each seeded violation (AT-234) |
| ASG-11 | The carrier sees addresses and access notes only once confirmed; the shipper sees registrations and the driver's name only once confirmed, and never why a resource is not eligible; no site contact is shown |
| ASG-12 | A confirmed booking whose resource loses eligibility stays confirmed, shows that it needs reassignment, and is not ready for dispatch |
