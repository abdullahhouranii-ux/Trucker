# Trucker: Release 1 decision record and remaining choices

Version 0.1, 15 November 2026. Owner and decision maker: Abdullah. This records the instructions of 15 November 2026 (11:13) against the decisions DB-1 to DB-18 of RELEASE_1_GAP_TO_LAUNCH.md, defines the reservation model that DB-6 needs before it is built, and batches the four groups of commercial choices still open: the fee, the payment due period, the assignment deadline and buffers, and the launch country and lanes.

No legal or tax rule is stated here. Every value that is not approved is a protected setting with a development default: it can be changed without code, and production refuses to start until the settings are reviewed (the existing production gate). Unapproved values therefore stop no decision-independent work and cannot reach real users.

## 1. Decisions recorded

| ID | Subject | Status after 15 November 2026 |
|---|---|---|
| DB-4 | Resource eligibility | **Approved for development.** Built in slice 13 with fictional registers. Real document and class lists remain open (X-5) |
| DB-5 | Company carriers only; one active carrier affiliation per driver | **Approved for development.** Built in slice 13. **Company-only replaced by ADR-001 (17 November 2026):** independent truck owners are added; one active affiliation per driver stays |
| FB-1 to FB-5 | Slice 13 decisions | **Approved for development**, with conditions FC-1 to FC-4 (FLEET_SLICE_13_SCOPE.md) |
| DB-1 | Settlement responsibility: recorded bank transfers | **Replaced by ADR-001 (17 November 2026):** Trucker's fee is paid online or by bank transfer and verified before confirmation; freight is settled separately and recorded; the organiser's commission is a recorded payable from carrier to organiser |
| DB-8 | Cancellation | **Proposed implementation structure.** No automatic fee; wording still needs the lawyer |
| DB-9 | Dispatch authority | **Proposed implementation structure** |
| DB-10 | Milestones only; no live GPS | **Approved for Release 1.** Live GPS is deferred |
| DB-11 | Phone web for drivers | **Approved for Release 1.** Native apps and the full offline queue are deferred. A report entered on someone else's behalf is clearly identified as such (E-4 below) |
| DB-12 | POD review | **Proposed implementation structure, with exception E-1** |
| DB-13 | Delivery exceptions | **Proposed implementation structure, with exception E-3** |
| DB-14 | Disputes and holds | **Proposed implementation structure, with exception E-2** |
| DB-15 | Reconciliation controls | **Proposed implementation structure** |
| DB-16 | Operational closure | **Proposed implementation structure** |
| DB-17 | Pilot invitation | **Proposed implementation structure** |
| DB-6 | Acceptance and reservation integrity | **Needs the model in section 3 before implementation.** The deadline and buffer values are in section 4 |
| DB-2 | Fee | **Timing replaced by ADR-001:** paid before confirmation, not invoiced after delivery. Basis and payer: ADR-001 defaults D-4 and D-5 |
| DB-3 | Currency and tax presentation | **Open** with the accountant (X-4). Not a value to recommend here |
| DB-7 | Missed confirmation deadline | Follows DB-6 and the terms (X-3); the structure stands as proposed, with no automatic consequence |
| DB-18 | Launch country and lanes | **Open**: section 4 |

"Proposed implementation structure" means the slices are scoped and built on that structure, each scope still comes to you for approval, and nothing in it is treated as an approved commercial or legal rule.

## 1A. Instructions of 15 November 2026 (13:15)

| Subject | Status |
|---|---|
| CC-1 to CC-6 | **Development defaults only**: the shipper pays 3%, rounded half-up; 15-day payment terms; the proposed assignment deadline and buffers. Built in slice 14 as protected settings. Production approval is separate |
| CC-7 | Geography **remains undecided** |
| Reservation model (section 3) | **Approved**, with this addition: a resource has **many historical occupancy episodes and only one open episode**. No POD action releases resources automatically |
| Short notice | If the calculated assignment deadline has already passed, acceptance is refused with a clear reason. No already-overdue booking is created. Built in slice 14, enforced also by a table constraint |
| Driver-submitted documents | Kept |
| Document expiry | Corrected in slice 13: the stated expiry date is preserved; each document type carries an explicit, configurable convention and time zone. Real conventions need country and document review before production |
| Confirmation | A booking is not confirmed until every required, eligible resource is assigned and reserved. Assignment and dispatch checks stay separate. Slice 15 scope: ASSIGNMENT_SLICE_15_SCOPE.md |

## 1B. Instructions of 15 November 2026 (14:23)

| Subject | Status |
|---|---|
| Slice 15 and AB-1 to AB-5 | **Approved as recommended.** Built on `feat/assignment`; scope and conditions AC-1 to AC-8 in ASSIGNMENT_SLICE_15_SCOPE.md |
| Staged release | Operational details only to authorised parties at the approved stage. Site contacts only when that feature and its privacy rules are approved; never invented. None is collected or shown |
| Reassignment | Follows the substitution rules: hard requirements are not waived, the price cannot change, a materially different substitute needs the shipper's acceptance. The old assignment stays until its replacement commits. A driver change ends the earlier acknowledgement |
| Confirmation and readiness | Historical confirmation is separate from current dispatch readiness. Lost eligibility blocks dispatch and requires reassignment; it never silently cancels |
| Acknowledgement | Required before dispatch |
| Before merging PR #20 | An immutable, versioned, demonstration-only terms reference on the booking, and refusals recorded without leaking another organisation's data. Both added to PR #20 |
| Missed assignment deadline | The shipper's explicit decision to wait is recorded. Cancellation without charge is slice 16. Nothing automatic |
| Choices made inside this scope | N-1 to N-6 in ASSIGNMENT_SLICE_15.md: see 1C and 1D |

## 1C. Instructions of 15 November 2026 (22:16)

| Subject | Status |
|---|---|
| Late initial assignment (migration 0016) | **Approved.** After the assignment deadline the carrier cannot make or change the initial assignment until the shipper records a decision to wait. A booking already confirmed is not affected by the deadline. This replaces N-4 |
| Slice 16 and CB-1 to CB-5 | **Approved as recommended.** Built on `feat/cancellation` (PR #22) |

## 1D. Instructions of 15 November 2026 (22:24)

| Subject | Status |
|---|---|
| N-1 | **Approved, with an addition:** after confirmation a vehicle replaced by one of the same category takes effect at once, and is now also recorded in the shipper's history and listed on the booking page, with the registrations only. Built on PR #22. The participant terms must allow like-for-like replacement with notice (X-3) |
| N-2 | **Approved:** any change of truck, trailer or driver ends the driver's acknowledgement |
| N-3 | **Approved:** a substitution proposal has no deadline; dispatch is refused while one is open (slice 17) |
| N-5 | **Approved:** before dispatch the driver sees areas, windows, cargo and vehicles; addresses from dispatch (slice 17); never the price |
| N-6 | **Approved:** overruns stay on their own records; in slice 17 each one opens an operations case |
| Slice 17 | Scope written for approval: DISPATCH_SLICE_17_SCOPE.md, decisions DD-1 to DD-10 |
| Broker role | New idea raised by Abdullah. Proposal for decision: BROKER_ROLE_PROPOSAL.md, decisions BR-1 to BR-8. Outside Release 1 until approved |

## 1E. Instructions of 17 November 2026

| Subject | Status |
|---|---|
| Commercial model | Abdullah's "Trucker development plan for partners" is recorded in `docs/specs/ADR_001_COMMERCIAL_MODEL.md`. Its confirmed requirements R-1 to R-25 stand and are not reopened. Defaults D-1 to D-12 and open decisions O-1 to O-7 await decision; each open decision has a working default |
| Replaced | DB-5 (company carriers only), DB-1 (recorded bank transfers only), DB-2's timing (fee after delivery), slice 15's confirmation without a payment check, D-001's "same transport price for both sides" for organiser bookings, and the broker proposal BR-1 to BR-8 |
| Unchanged | D-001 (agent), the reservation model, staged release, cancellation before dispatch, E-1 to E-4 |

## 1F. Instructions of 17 November 2026 (09:12 and 09:27)

| Subject | Status |
|---|---|
| Freight payment | **Abdullah's requirement (ADR-001 R-26):** cash on delivery, bank transfer or the carrier's activated card gateway, with the method and due date fixed on each booking |
| Slice 21 | **Approved**, with P2-1 (one truck, one trailer, the owner as the only driver) and P2-2 (one personal account may organise and carry, never quoting on its own shipment) as recommended. Built on `feat/individual-accounts` |
| Not approved by these instructions | Any merge, and any production financial policy. Defaults stay in development. Dispatch and proof of delivery stay a parallel workstream |

## 1G. Instructions of 17 November 2026 (10:36)

| Subject | Status |
|---|---|
| Slice 22 | **Approved** with S22-1, S22-2 and S22-3 as recommended. Added tests: two organisers serving one customer; shipment-specific access; revocation while a command waits; explicit fee-payer agreement; preserved booking snapshots; first-time broker onboarding. The organiser is recorded on its own shipments as well as those arranged for a customer. Built on `feat/shipment-roles` |
| Not authorised | Merging, deployment, and DD-1 to DD-10 |


## 1H. Instruction of 17 November 2026 (11:46): "proceed all slices"

| Subject | Status |
|---|---|
| Reading | Build the remaining slices in order without a scope approval for each, using the recommendations as development defaults. Stated to Abdullah when work began; not yet confirmed or corrected by him |
| What it does not do | It does not merge, deploy, approve any production financial policy, or approve D-1 to D-12, O-1 to O-7 or DD-1 to DD-10. Each default used is listed in the record of the slice that uses it |
| Dispatch | DD-1 to DD-10 will be taken as development defaults when the dispatch slice is reached, unless Abdullah says otherwise |
| Slice 23 | Built with D-1, D-2, D-3 and O-1 as development defaults: `COMMISSION_SLICE_23.md` |
| Slice 23b | Built with D-3, D-10, C-1 and C-2 as development defaults: `COMMISSION_CONTRACTS_SLICE_23B.md`. C-2 (quotations under an ended contract) is open for Abdullah |
| Slice 24 | Built with the values in use as the development default version, and F-1 to F-3: `FINANCIAL_SETTINGS_SLICE_24.md`. F-1 (finance privilege) and F-2 (one-person withdrawal) are open for Abdullah |

## 2. Exceptions to the proposed structures

| ID | Exception | Effect on the build |
|---|---|---|
| E-1 | **No operations acceptance of a POD on a shipper's behalf** until explicitly approved | Only the shipper's administrators accept or reject a POD. Operations can record a case and contact the shipper. No route, button or setting accepts on behalf. If a shipper never answers, the booking waits in the operations queue |
| E-2 | **No binding dispute decision** without approved authority | Staff record a mediation outcome as a recommendation, with what each party said in reply. A hold is released only when both parties record agreement, the raising party withdraws, or an approved authority is later defined. Nothing is labelled a decision that binds |
| E-3 | **No automatic physical resource release** merely because a POD is recorded | Recording or accepting a POD changes no occupancy. A resource is released only by its own recorded act (section 3.4) |
| E-4 | **Reports entered on someone else's behalf are clearly identified** | Every milestone, delivery outcome and POD item stores who the report is about and who entered it. When they differ it is shown as "entered by … on behalf of …" with the reason, on every screen, export and audit entry, and its time is marked as reported, not observed |

## 3. Reservation model for DB-6 (to be approved before slice 15)

Planned reservation and actual occupancy are two separate records. Neither is derived from the other, and neither is derived from the POD.

### 3.1 Planned reservation interval

| Item | Definition |
|---|---|
| What it is | One record per resource (truck, trailer, driver) per booking: the time the resource is planned to be committed. State `active` → `released` |
| Planned start | The start of the pick-up window minus the **positioning buffer** (section 4) |
| Planned end | The end of the delivery window plus the **completion buffer** (section 4) |
| Interval | Half-open, `[planned start, planned end)`, so back-to-back reservations are allowed |
| Integrity | The database refuses two active reservations of one resource whose intervals overlap (an exclusion constraint, not an application check), whichever organisation asks |
| When it is created | When the carrier assigns the resource to the booking. The booking is confirmed only when every required resource has an active reservation and is eligible for the whole interval (slice 13 functions) |
| When it changes | Only through a recorded act: reassignment, cancellation before dispatch, or release (3.4). The window on the booking snapshot never changes |

### 3.2 Actual occupancy

| Item | Definition |
|---|---|
| What it is | An occupancy episode: one record per resource per dispatch, the fact that the resource is physically committed. It opens when dispatch is authorised and recorded, and stays open until the resource is released. A resource accumulates many closed episodes over time |
| Integrity | A resource has at most one open episode (a unique index on open episodes only), and any number of closed ones. **A resource with an open occupancy cannot be dispatched on another booking**, whatever the planned intervals say. This is a dispatch precondition checked in the database |
| What it is not | It is not ended by the planned end passing, by a milestone, or by a POD being recorded or accepted (E-3) |

### 3.3 Overrun protection

A resource overruns when the clock has passed its planned end and its occupancy is still open.

| Rule | Definition |
|---|---|
| Effective end | While the occupancy is open, the reservation counts as lasting until `greatest(planned end, now)`. The check is made live with the database clock; no worker is needed |
| New reservations | A new reservation of that resource that would start before the effective end is refused, exactly like an overlap |
| Next dispatch | Blocked by 3.2 until the resource is released |
| Reservations already made | A later booking that already holds the resource is not cancelled or reassigned automatically. It is flagged "at risk" in the operations queue and on the carrier's page as soon as the earlier occupancy passes its planned end, and its dispatch stays blocked. The carrier reassigns or the parties cancel under the cancellation structure |
| Record | The overrun is recorded once per reservation, with the system as actor, when it is first seen |

### 3.4 Release

| Item | Definition |
|---|---|
| Who | The carrier's administrator or dispatcher, for each resource, or operations inside a case |
| When allowed | Only after a delivery outcome is recorded, and only if no cargo custody is open for that resource. With a partial or refused delivery, the custody record must show the cargo handed over, or operations must confirm the release in the case |
| Effect | The occupancy closes and the reservation becomes `released` at the release time. If that is before the planned end, the remaining planned time is freed |
| Before dispatch | Cancelling the booking, or reassigning the resource, releases the reservation; no occupancy ever existed |
| Recorded on behalf | A release entered by operations for the carrier is identified as such (E-4) |

### 3.5 Tests the slice must carry

- Two simultaneous assignments of one resource to overlapping intervals: one succeeds.
- Intervals that touch both succeed.
- A resource whose occupancy is open past its planned end: a new reservation starting before now is refused; the later booking's dispatch is refused; the later booking is flagged once.
- Recording and accepting a POD leaves the occupancy open.
- Release is refused with custody open, and succeeds after the custody is closed.
- A consistency check reports nothing for a correct booking in every state, and reports each seeded violation (AT-234).

## 4. Remaining commercial choices, with recommended values

These are the only choices still needed from you for slices 14, 15 and 19 and for launch. Each value below is a recommendation for your approval. None rests on market evidence: the competitor research could not establish fee levels or payment terms, so the values should be tested with a few carriers and shippers before launch. None is a legal or tax rule.

| ID | Choice | Recommended value | Why | Alternative |
|---|---|---|---|---|
| CC-1 | **Fee payer** | The shipper | The carrier receives exactly the price it quoted, which keeps quotations comparable and gives carriers no reason to pad them. The shipper sees the fee before accepting | The carrier pays (simpler for shippers; carriers will add it to their prices) |
| CC-2 | **Fee basis** | A percentage of the agreed transport price, rounded half-up to the currency's minor unit, fixed in the booking snapshot at acceptance | Scales with the job and needs no price bands | A fixed amount per booking (simpler, but heavy on short hauls) |
| CC-3 | **Fee amount** | 3% for the pilot, with no minimum | A starting figure only. The Middle East payments research noted card fees of about 2–3% that "can exceed the platform's own commission", which suggests low single digits; there is no direct evidence | 0% for a first block of bookings, to recruit participants, with the fee line shown as zero |
| CC-4 | **Payment due period** | The shipper pays the carrier within 15 days of POD acceptance. Trucker's fee invoice is due 15 days after its date. A shipper with an overdue, undisputed payment cannot publish new shipments until it is recorded as paid | Carriers will compare with faster payers; 15 days is a middle position between that and ordinary credit terms. The overdue rule is the promise already described for option A | 30 days (easier for larger shippers, weaker for carriers) |
| CC-5 | **Assignment deadline** | The carrier assigns every resource within 12 hours of acceptance, and never later than 6 hours before the pick-up window opens, whichever comes first | Gives the shipper certainty the same day and leaves time to react before pick-up | 24 hours (easier for carriers with shifts) |
| CC-6 | **Reservation buffers** | Positioning buffer 2 hours before the pick-up window. Completion buffer 12 hours after the delivery window. Travel to the pick-up point is not counted | Small enough not to waste capacity; the overrun protection in 3.3 covers anything longer, so the buffers do not need to be generous | Larger buffers once real trip times are known |
| CC-7 | **Launch country and lanes** | Oman first, with the domestic lane Muscat ↔ Salalah. Then Oman–UAE, Muscat/Sohar ↔ Dubai, once both countries' readiness records are approved | One country and no border proves the whole journey with the least outside work. The second lane is the commercial target. This is the earlier recommendation (L2, then L1), unchanged, and it is not chosen automatically | Start with Oman–UAE if the pilot participants are on that corridor |

CC-3 and CC-4 need the accountant's view of how the fee is invoiced and taxed (X-4), and CC-4 and CC-5 belong in the participant terms (X-3). Approving the values here lets development use them as defaults; it does not replace those reviews.

## 5. Carried forward

- PRs #15 to #18 and the slice 13 PR stay unmerged until a focused dependency review and explicit merge authorisation.
- SEC-01 remains a release blocker until PR #17 is merged and staging is green.
- TruckLink, `main` and deployments are untouched.
- Wording and translation polish stays in the final audit.
