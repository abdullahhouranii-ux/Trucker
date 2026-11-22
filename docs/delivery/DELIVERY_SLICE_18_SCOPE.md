# Trucker: delivery, proof of delivery and release, slice 18, scope and acceptance criteria

Version 0.1, 18 November 2026. Status: **for approval.** Built on development defaults under Abdullah's instructions of 17 November 2026 (11:46, phase five on development defaults) and 18 November 2026 (08:38, "agreed proceed"): what is built is recorded in each part's record, and nothing here is treated as an approved commercial or legal rule. Sources: `docs/specs/STAGE_2_PART_4_POD_DISPUTES.md` (sections 2 to 7 and the open design issues DI-401 to DI-405); decisions DB-12, DB-13 and DB-14 (proposed implementation structures) with exceptions E-1, E-3 and E-4; the reservation model (RELEASE_1_DECISIONS.md section 3, approved, with "no POD action releases resources automatically").

Delivered as three focused pull requests: **18a** the delivery outcome, cargo custody and the release of resources; **18b** proof of delivery: files, the completion manifest, review; **18c** disputes and settlement holds. Each depends on the one before.

## 1. What this slice is

**18a.** Once the truck has arrived at delivery, the driver records one delivery outcome; the carrier's administrator or operations may record it on the driver's behalf, marked as reported (E-4). Any outcome other than delivered in full opens an operations case. Where cargo remains on the vehicle, a custody record is open until a handover is recorded. Each resource is released by its own recorded act, only when the release condition holds (DI-403): the occupancy closes and the reservation is released. Nothing releases a resource automatically (E-3).

**18b.** The driver captures proof of delivery: a manifest of required and optional items, then the files themselves, each with a fingerprint checked on receipt (DI-402, DI-405). A POD is ready for review only when every required item is received. The shipper's administrators accept it or ask for more evidence, explicitly; silence never accepts (DB-12, E-1). A correction is a new version. Files are kept behind a storage interface with a development stand-in only: no storage supplier is chosen (R1-V7, D-011).

**18c.** Either party opens a dispute on a booking. Each dispute owns its own settlement hold, released only by its own recorded decision, withdrawal or closure (DI-401, DB-14). Staff mediate and record decisions with reasons; one appeal, decided by someone else.

## 2. Rules carried in

| Source | Rule |
|---|---|
| E-3 | No resource is released because a POD is recorded or accepted, or because a time passes |
| E-4 | Anything entered on someone else's behalf shows who it is about, who entered it and why, and its time is marked as reported |
| E-1 | Only the shipper's administrators accept or reject a POD. Operations never accepts on the shipper's behalf until that is explicitly approved |
| DI-403 | A resource is released only when: the outcome is delivered in full, or delivered with remarks with nothing left on the vehicle; and no custody is open; or operations confirms the release in a case |
| DI-402 | A POD is reviewed only when every required item of its manifest has been received |
| DI-405 | A matching fingerprint is shown as transfer integrity only, never as proof that the delivery happened |
| DI-401 | Holds are separate records, one per cause; the booking is "held" while at least one is active |
| R-402 | Without an approved rule, no POD is accepted by the passage of time |

## 3. Acceptance criteria

**18a: outcome, custody and release**

| ID | Criterion |
|---|---|
| DLV-1 | An outcome is recorded only after "arrived at delivery", only while the trip is not on hold, by the assigned driver (observed) or on the driver's behalf by the carrier's administrator or operations with a reason (reported) |
| DLV-2 | One outcome is in force per trip. Operations may correct it with a reason; the earlier one stays visible |
| DLV-3 | Any outcome other than delivered in full opens one operations case for the trip |
| DLV-4 | Partly delivered, refused and not delivered open a custody record for the cargo left on the vehicle; delivered with remarks opens one when the recorder says cargo remains |
| DLV-5 | Custody closes only with a handover: returned to the shipper, delivered elsewhere or handed to a replacement vehicle, with who handed over, who received, when and where |
| REL-1 | A resource is released only by the carrier's administrator or operations, one resource at a time, only after an outcome, and only when the release condition holds; otherwise refused with the reason |
| REL-2 | Operations may release with custody still open only with a note, recorded as an operations release |
| REL-3 | A release closes the occupancy episode and releases the reservation in one transaction; a released resource can then be dispatched on its next booking |
| REL-4 | Nothing else closes an episode: not an outcome, not a milestone, not the passage of time, not a direct write without a release record |
| REL-5 | Two releases of one resource at the same moment record one release |

**18b and 18c** are scoped in detail before they are built, with the acceptance tests AT-401 to AT-415 and AT-421 to AT-426 of Part 4 adjusted by DI-401, DI-402 and DI-405.

## 4. Out of this slice

Payment, invoicing and settlement; any fee or charge for refused cargo, return or storage; waiting-time claims; adjustments (R-407); notifications; offline capture.

## 5. Decisions needed (with recommendations)

| ID | Decision | Recommendation (used as a development default) |
|---|---|---|
| DL-1 | Outcomes in Release 1 | The five of Part 4: delivered in full, delivered with remarks, partly delivered, refused, not delivered. DB-13 named four; "not delivered" covers a receiver who is absent or a site that is closed |
| DL-2 | What an outcome records | The outcome, the receiver's name (not needed for refused or not delivered), remarks (needed for every outcome except delivered in full), and whether cargo remains on the vehicle (implied for partly delivered, refused and not delivered) |
| DL-3 | Who records custody handovers | The carrier's administrator or operations. A handover type from DL-4, who handed over, who received, the time and the place |
| DL-4 | Handover types | Returned to the shipper; delivered to another place; handed to a replacement vehicle. Who instructs and who pays for return or storage is not decided here (R-406) |
| DL-5 | Who releases | The carrier's administrator, or operations (shown as such). The driver does not release |
| DL-6 | Correcting an outcome | Only operations, with a reason, as a new version; the earlier one stays visible. Not allowed once a handover or a release is recorded |
