# Trucker: dispatch and trip execution slice 17, scope and acceptance criteria

Version 0.1, 15 November 2026. Status: **approved by Abdullah on 18 November 2026 (06:10), with DD-1 to DD-10 as recommended.** Slice 17a is built (`DISPATCH_SLICE_17A.md`, PR #33) and slice 17b (`EXCEPTIONS_SLICE_17B.md`). Sources: `docs/specs/STAGE_2_PART_3_DISPATCH_TRACKING_EXCEPTIONS.md` sections 2 to 4 and 8; decisions DB-9 (proposed structure), DB-10 and DB-11 (approved for Release 1) and exception E-4 in RELEASE_1_DECISIONS.md; the slice 15 choices N-3, N-5 and N-6 approved on 15 November 2026 (22:24); the cancellation boundary of slice 16.

Delivered as two focused pull requests: **17a** dispatch, the trip and its milestones; **17b** exceptions and operations cases. 17b depends on 17a.

## 1. What this slice is

**17a.** The carrier's administrator dispatches a confirmed booking. At that moment the database checks every precondition again and, in the same transaction, opens an occupancy episode for the truck, the trailer if any and the driver, and creates the trip. From then on the booking can no longer be cancelled by the parties (slice 16 already refuses once an episode exists). The driver records milestones on a phone; the carrier's administrator or Trucker operations may record one on the driver's behalf, marked as such. The shipper follows the milestones and the latest stated arrival estimate. The driver sees the pick-up and delivery addresses and access notes from dispatch on.

**17b.** The driver, the carrier, the shipper or the system reports an exception on a trip. Trucker operations acknowledges it, owns it in a case, records each action with a reason, and resolves it. A resource still occupied past its planned end opens a case automatically, so a person owns every overrun (N-6). Operations can block a dispatch before it happens, and put a trip on hold and resume it.

## 2. Rules carried in

| Source | Rule |
|---|---|
| DB-9 | The carrier dispatches. The server enforces the preconditions. Operations can block a dispatch with a recorded reason |
| DB-10 | Milestones only. No live location is collected. The shipper sees milestones and the latest stated arrival estimate |
| DB-11 | Drivers use the web application on a phone. When a driver cannot record, the carrier's administrator or operations records on the driver's behalf, with a reason, and the stated time is marked as reported. The full offline queue is deferred |
| E-4 | A report entered on someone else's behalf shows who it is about, who entered it and why, everywhere it appears, and its time is marked as reported, not observed |
| N-3 | Dispatch is refused while a substitution proposal is open |
| N-5 | The driver sees addresses and access notes from dispatch on. The driver never sees the price or the fee |
| N-6 | An overrun is linked to an operations case, so a person owns it |
| Reservation model 3.2 | An occupancy episode opens at dispatch and closes only by a recorded release. A resource has at most one open episode. Nothing here closes one: release is slice 18 |
| Slice 16 | Dispatch takes the same locks, in the same order, as cancellation: both organisations, the shipment, the booking's assignment state, the resources. A dispatch and a cancellation at the same moment end with exactly one of them |
| Slice 15 | The confirmation stays a fact of the past. Whether dispatch is possible is judged now, on the same blocker list the booking page already shows |

## 3. Dispatch preconditions (17a)

All judged by the database at the moment of dispatch, after the locks. The refusal names the first that fails.

| Precondition | Source |
|---|---|
| The booking is confirmed and not cancelled | Slices 15, 16 |
| Every assigned resource still meets every hard requirement for the rest of the planned interval | Slice 15 |
| The driver has acknowledged the current set | AB-5 |
| No resource has an open occupancy on another booking | Reservation model 3.2 |
| No substitution proposal is open | N-3 |
| No operations block is in force (17b; until then, none can exist) | DB-9 |
| The shipper and the carrier both hold their capability now | Part 3, section 3 |
| The moment is within the dispatch window: not earlier than a set number of hours before the planned reservation start | Parameter, DD-2 |

## 4. Out of this slice

Live location and tracking links; the offline queue and device streams; photos (file storage is undecided, R1-V7); messaging on a trip; notifications; the delivery outcome, proof of delivery, release of resources and aborting a trip (slice 18); any charge for waiting or delay.

## 5. Acceptance criteria

**17a: dispatch and milestones**

| ID | Criterion |
|---|---|
| DSP-1 | Only an administrator of the booking's carrier dispatches. Others are answered as for a missing record |
| DSP-2 | Each precondition in section 3, seeded to fail on its own, refuses dispatch with its name and changes nothing (AT-301) |
| DSP-3 | A document that lapsed a minute earlier refuses dispatch (AT-304) |
| DSP-4 | Dispatch opens one occupancy episode for each assigned resource and creates the trip in one transaction. A repeated request returns the first trip and changes nothing (AT-306) |
| DSP-5 | Dispatch and cancellation at the same moment: exactly one happens. After dispatch, cancellation is refused |
| DSP-6 | Two bookings sharing a resource dispatched at the same moment: at most one succeeds; a resource still occupied by an overrunning trip blocks the next dispatch (AT-310) |
| DSP-7 | After dispatch no assignment, substitution, acknowledgement or wait decision changes the booking |
| TRP-1 | The trip moves only through the allowed sequence of milestones; a skipped or repeated step is refused with the current state and changes nothing (AT-311) |
| TRP-2 | Only the assigned driver, while affiliated with the carrier, records milestones as the driver. A driver who left cannot (AT-302, AT-313) |
| TRP-3 | A milestone recorded on behalf shows who recorded it, for whom and why, and its stated time is marked as reported. A stated time in the future is refused; one earlier than the previous milestone is accepted and marked for review (AT-312) |
| TRP-4 | Arrival and departure times at each site are retrievable as evidence, with observed and reported times told apart (AT-314) |
| TRP-5 | The shipper sees milestones and the latest stated arrival estimate, with who stated it and when, and nothing about resources beyond what slice 15 shows |
| TRP-6 | The driver sees addresses and access notes from dispatch, never before, and never the price, the fee or another booking |
| TRP-7 | No occupancy episode is closed by anything in this slice |

**17b: exceptions and operations**

| ID | Criterion |
|---|---|
| EXC-1 | The driver, the carrier, the shipper or the system reports an exception on a trip with a type and description. It appears in the operations queue at once (AT-351, without the offline part) |
| EXC-2 | Only staff holding the operations privilege acknowledge, act on and resolve exceptions, block or unblock a dispatch, and put a trip on hold or resume it; every action records who, when and why (AT-305, AT-352) |
| EXC-3 | A resource still occupied past its planned end opens one case, linked to the overrunning trip and to each later booking it puts at risk; the case is recorded once however often the overrun is seen (N-6, AT-353) |
| EXC-4 | A trip on hold accepts no milestone until it is resumed |
| EXC-5 | The parties see that an exception exists, its type and its state; internal notes stay with operations |

## 6. Decisions needed (with recommendations)

| ID | Decision | Recommendation |
|---|---|---|
| DD-1 | One step or two? The specification has an authorisation that can lapse or be invalidated, then a start re-checked when the driver begins | **One step for Release 1.** The carrier dispatches; the database checks everything at that moment and opens the occupancy at once. Nothing can go stale between two steps, and AT-307 to AT-309 do not arise. The two-step form can return with the offline queue |
| DD-2 | Earliest dispatch | No earlier than **12 hours before the planned reservation start**, as a protected setting with a development default. No latest time: a late dispatch is allowed and shown as late |
| DD-3 | Who in Trucker may block and handle exceptions | A new staff privilege, **operations**, granted by a staff administrator like the others. A reviewer cannot use it |
| DD-4 | What the parties see of an operations block | That dispatch is blocked by Trucker operations and a reason from a fixed list (safety review, document concern, suspected fraud, other). The free-text note stays internal |
| DD-5 | Milestones in Release 1, and where slice 17 ends | Departed for pick-up; arrived at pick-up; loading started; loaded and departed; arrived at delivery; unloading started. The delivery outcome (in full, with remarks, partial, refused) is slice 18 with the proof of delivery |
| DD-6 | Recording on behalf | The carrier's administrator or operations, with a reason from a fixed list (driver has no phone, no signal, driver unable, correction, other with a note) and the stated time |
| DD-7 | Arrival estimate | The driver or the carrier's administrator states an estimated arrival at delivery at any time after dispatch; the shipper sees the latest, with who stated it and when |
| DD-8 | What the driver sees at dispatch | Addresses and access notes from the confirmation record, and the shipper's name, which a driver needs at the gate. Never the price or the fee |
| DD-9 | System-raised cases (17b) | Two: a resource still occupied past its planned end (N-6), and no "arrived at pick-up" by the end of the pick-up window. Neither has an automatic consequence |
| DD-10 | Exception types in Release 1 | Delay; breakdown; accident; cargo damage or shortage; refused or blocked at a site; receiver absent; document problem; road closed; safety concern; no-show; other. The app tells the driver to call the country's emergency number directly in an emergency; Trucker dispatches no emergency service |
