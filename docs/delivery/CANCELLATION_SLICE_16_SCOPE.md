# Trucker: cancellation before dispatch slice 16, scope and acceptance criteria

Version 0.1, 15 November 2026. Status: **for approval. Nothing here is built.** Sources: `docs/specs/STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md` section 8 (AT-241 to AT-244); decision DB-8, a proposed implementation structure (RELEASE_1_DECISIONS.md); the instruction of 15 November that cancellation without charge after a missed assignment deadline belongs here.

No fee, compensation or legal consequence is stated in this scope. The cancellation record stores the facts a later, approved policy would need; it applies no policy.

## 1. What this slice is

Before dispatch, the shipper or the carrier cancels a booking with a reason from a fixed list. In one transaction the booking is recorded as cancelled, every active reservation and any open substitution proposal is released, and the facts of the cancellation are stored. The shipper may then publish the shipment again as a new publication. Nothing is charged, and nothing is cancelled automatically.

## 2. Rules (proposed structure, restated)

| Rule | Definition |
|---|---|
| Who | An administrator of the shipper or of the carrier. Operations cancel only inside a recorded case, which is slice 17's exceptions work and is not built here |
| When | Any time before dispatch. Dispatch does not exist yet, so every booking qualifies until slice 17 adds the boundary |
| Reason | One code from a fixed list, with an optional note. The list is a register, fictional in development |
| Effect | One transaction: a cancellation record; every active reservation released; an open substitution proposal ended; the driver's assignment no longer shown. The booking snapshot is not changed: cancelled is a state that follows from the record, like confirmed |
| Record | Who cancelled and for which party, when, how long before the pick-up window opens, the reason, whether the booking was confirmed, whether the assignment deadline had passed and whether the shipper had decided to wait, and the booking's terms reference |
| Charge | None is calculated, shown or implied. The record carries the field `charge_basis` with the single value `none_recorded` |
| After a missed assignment deadline | The shipper's cancellation is recorded as made after the carrier missed the deadline. That fact is stored; what it means commercially is for the approved terms |
| Shipment afterwards | The awarded shipment becomes "booking cancelled". The shipper may republish it as a new publication cycle; old quotations are not revived |
| Repeats | A second cancellation request returns the first result and changes nothing |

## 3. Out of this slice

Any fee, refund or compensation; cancellation after dispatch; cancellation by operations; automatic cancellation of any kind; notifications.

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| CAN-1 | Only an administrator of the shipper or of the carrier of that booking cancels. Others are answered as for a missing record |
| CAN-2 | After cancellation the same truck, trailer and driver can be reserved for the same interval immediately (AT-241) |
| CAN-3 | A repeated request, and two simultaneous requests from the two parties, leave one cancellation record (AT-242) |
| CAN-4 | Cancellation and a simultaneous assignment, substitution decision or acknowledgement cannot leave an active reservation, an open proposal or a new confirmation on a cancelled booking (AT-243) |
| CAN-5 | The record holds every fact in section 2, and nothing about a charge except that none is recorded (AT-244) |
| CAN-6 | The booking snapshot and the confirmation record, if any, are unchanged |
| CAN-7 | A cancelled booking takes no assignment, acknowledgement, wait decision or substitution, and is not ready for dispatch |
| CAN-8 | The shipper can republish the shipment; a new acceptance creates a new booking; the cancelled one stays readable by both parties and staff |
| CAN-9 | The consistency check reports an active reservation on a cancelled booking |
| CAN-10 | Screens pass the existing browser checks in EN, AR and UR at phone widths; a lost cancellation answer leaves one cancellation and is never reported as done unless confirmed |

## 5. Decisions needed (with recommendations)

| ID | Decision | Recommendation |
|---|---|---|
| CB-1 | Reason codes | Shipper: `shipment_no_longer_needed`, `dates_changed`, `carrier_did_not_assign`, `other`. Carrier: `resource_unavailable`, `cannot_meet_window`, `other`. A note is optional, and required for `other`. Fictional register in development |
| CB-2 | A booking is limited to one shipment today. After cancellation, may the shipper republish the same shipment, or must it copy it? | Republish the same shipment as a new publication cycle, so its history stays in one place. The cancelled booking stays attached to the earlier cycle |
| CB-3 | What each party is shown of the other's cancellation | The party that cancelled, the reason code and the time. The note only to the cancelling party and staff |
| CB-4 | Wording shown before cancelling | "Cancelling ends this booking and releases the carrier's resources. No charge is calculated here. What either party owes the other, if anything, is not decided by Trucker." Final wording needs the lawyer (X-3) |
| CB-5 | May a party cancel while a substitution proposal is open? | Yes. The proposal ends as part of the cancellation |
