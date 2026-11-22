# Trucker: Release 1 gap-to-launch plan

Version 0.1, 15 November 2026. Status: **plan for approval.** Supersedes the quotation-only pilot definition of 15 November 2026 (Abdullah, 15 November 2026, 10:40). Recommendations below are not approvals, and no business rule is chosen here.

## 1. Release 1

One continuous journey, for invited, verified organisations:

> shipment → quotation → acceptance → booking → valid resource assignment → trip execution → proof of delivery → financial recording → operational closure

Rules that do not change:
- Payments are manual: recorded bank transfers with named owners, audit history and reconciliation. No payment provider integration is needed for launch.
- Optional features and cosmetic polish stay deferred.
- SEC-01 and every release-blocking security, functional and data-integrity defect is fixed before real use.
- Trucker stays separate from TruckLink.
- `main` and deployments stay untouched until explicitly authorised.

## 2. What exists

Slices 1 to 10 are merged into `staging` (last merge: PR #14, `1eaf3f2`). Nothing is on `main`, and nothing is deployed.

| Area | State | Where |
|---|---|---|
| Foundation, CI, migration runner, errors, request identifiers | Merged | Slices 1 and 2 |
| Web shell in EN, AR and UR; registration and sign-in (development only) | Merged | Slices 3 and 4 |
| Organisations; database hardening (API role reaches data only through functions) | Merged | Slices 5 and 6 |
| Shipment drafts | Merged | Slice 7 |
| Staff identity and console (two-factor, privileges, audit) | Merged | Slice 8 |
| Organisation verification (demonstration evidence) | Merged | Slice 9 |
| Shipment publication, expiry and suspension | Merged | Slice 10 |
| Carrier capability and discovery | PR #15, CI green, unmerged | Slice 11 |
| Comparable quotations (one currency, exact amounts, inclusions, expiry, reconfirmation) | PR #16, CI green, unmerged | Slice 12 |
| SEC-01 fix | PR #17, unmerged | This plan |

Nothing exists yet for:
- vehicles, trailers and drivers;
- acceptance, bookings and reservations;
- trips, POD and disputes;
- fees, invoices and payment records;
- operational closure;
- the pilot invitation mechanism.

## 3. Essential missing work, in build order

Each step is one slice with its own scope for approval, as before. A step marked "blocked" can be scoped, but not built, until the named decisions are made.

| # | Slice | What it must prove | Needs decisions (section 5) |
|---|---|---|---|
| 13 | **Fleet and drivers** | Carriers register trucks, trailers and drivers. Each resource carries documents that staff verify, with expiry dates. Eligibility is judged live, the same way organisation verification is | DB-4, DB-5. Can start with fictional document types |
| 14 | **Acceptance and booking** | The shipper accepts one quotation version. In one transaction the shipment is awarded, the other quotations are not selected, and a booking holds an immutable snapshot of price, currency, fee, tax presentation and terms. Exactly one booking survives a race. A retried acceptance changes nothing more | DB-1, DB-2, DB-3, DB-6 |
| 15 | **Resource assignment and reservation** | The carrier assigns eligible resources. The database refuses overlapping reservations. The booking is confirmed only with a valid assignment, and the driver acknowledges it. A missed deadline follows the approved rule | DB-5, DB-6, DB-7 |
| 16 | **Cancellation before dispatch** | Either party cancels under the approved rule. Reservations are released. Any charge is recorded, never invented | DB-8 |
| 17 | **Dispatch and trip execution** | Dispatch is authorised only when the server-side preconditions hold: eligibility, documents and reservations. Milestones are recorded by the driver, or on the driver's behalf with a reason. Exceptions open an operations case | DB-9, DB-10, DB-11 |
| 18 | **Proof of delivery and delivery exceptions** | POD is captured with a manifest (DI-402) and reviewed explicitly; silence never accepts it. Refusals, partial deliveries and custody are recorded. Resources are released only on the release condition (DI-403). Disputes create separate holds (DI-401) | DB-12, DB-13, DB-14 |
| 19 | **Financial recording** | The fee and its tax presentation are calculated exactly. Fee invoices are recorded and payments recorded manually. Both parties record and confirm transport payments. Staff reconcile against bank statements with maker-checker approval. Holds block settlement eligibility | DB-1, DB-2, DB-3, DB-15 |
| 20 | **Operational closure** | A booking closes only when POD is accepted, no hold is active, reservations are released and the payment records reconcile. An operations queue lists everything stuck, with an owner. A consistency check covers every state (AT-234) | DB-16 |
| — | **Pilot invitation** | Only invited organisations can register | DB-17 |
| — | **Shared release work** | File storage for documents and POD. Production gates. The open investigations (slice-4 test failure, PR #9 diagnosis) | External items in section 4 |

Slices 13, 14 and 15 can overlap in scoping. Slices 17 to 20 depend on 15.

## 4. External blockers (outside the code)

| ID | Blocker | Owner | Blocks |
|---|---|---|---|
| X-1 | Launch country and lanes (D-003b, D-003c). Not chosen; GCC priority | Abdullah | Real configuration, currency, documents, hosting region |
| X-2 | Operating legal entity and bank account for fee receipts (D-007) | Abdullah with advisers | Invoices, reconciliation, terms |
| X-3 | Participant terms, privacy notice, agent-model wording, cancellation and dispute wording; licence question | Lawyer in the chosen country | Production registration; DB-8, DB-13, DB-14 |
| X-4 | Tax treatment of Trucker's fee and how transport prices are presented | Accountant | DB-3, fee invoices |
| X-5 | Real evidence requirements for organisations, vehicles, trailers and drivers in the chosen country | Abdullah with advisers | Real verification; DB-4 |
| X-6 | Cargo liability and insurance position (P-208) | Insurance and legal adviser | Booking terms, delivery exceptions |
| X-7 | Suppliers: hosting, SMS for sign-in codes, file storage (D-011). All paid | Abdullah | Production |
| X-8 | Operations staffing and support hours (D-010) | Abdullah | Exceptions, reconciliation, closure |
| X-9 | Pilot participants and their consent to the pilot terms | Abdullah | User testing, launch |

## 5. Business decisions, batched, with recommended answers

None of these is chosen. Wherever a rule needs legal, tax or insurance review, the recommendation is a structure for that review to fill, not the rule itself. Numbers (days, rates, buffers) are left to you.

| ID | Decision | Recommended answer | Why | Review needed |
|---|---|---|---|---|
| DB-1 | **Settlement responsibility (D-002)** | Option A for Release 1. The shipper pays the carrier the transport price directly by bank transfer. The carrier records receipt. Trucker records its own fee invoices and the bank transfers it receives. Staff reconcile against bank statements, with a second staff member approving each reconciliation. No money for transport passes through Trucker | Matches your instruction (manual, recorded bank transfers) and the agent model. No provider is needed | You set the payment days after POD acceptance, and what happens to an overdue shipper |
| DB-2 | **Fee (D-001a, D-001b)** | One fee per booking, paid by one named party and shown separately from the transport price. Calculated exactly in the booking currency. The rounding rule is stated, and the fee is fixed in the booking snapshot at acceptance. Trucker invoices it after POD acceptance | Keeps the agreed transport price identical for both sides. The calculation is reproducible | You choose the payer (shipper, carrier or both), the basis (percentage or fixed) and the level. Whether the pilot is fee-free is also yours |
| DB-3 | **Currency and tax presentation** | Keep one currency per shipment, chosen by the shipper. The transport price is shown "as agreed between the parties", with the carrier's declared tax status recorded as a declaration. The fee shows its own tax line as the accountant specifies. All amounts are exact decimals and never converted | Trucker does not determine tax on a transport contract it is not party to | Accountant (X-4). Real currencies follow X-1 |
| DB-4 | **Resource eligibility** | A truck, trailer or driver is eligible only while every document required for it is staff-verified and unexpired, judged live when it is assigned and again at dispatch. Truck and trailer must also be compatible with the shipment's equipment type. A driver's licence class must cover the vehicle | The same live judgement as organisation verification; the spec already lists these checks (Part 2, 7) | Which documents, and which classes, per country (X-5) |
| DB-5 | **Driver affiliation (Q-102) and operating control** | In Release 1 a driver belongs to one carrier organisation. Resources are owned or operated by the carrier that assigns them, and nothing is shared between carriers yet | Removes cross-organisation consent rules for the pilot | Legal input on employment and agency status |
| DB-6 | **Acceptance and reservation integrity (P-207, P-201, P-206)** | Only the shipper's administrators may accept. Accepting is final and names the exact quotation version. The carrier must then assign all resources within a confirmation period; until then the booking is "awaiting resources". Reservations run from the start of the pick-up window minus a buffer until the release condition (DI-403). Overlaps are refused by the database | Quotations name no resources (QB-7), so assignment follows acceptance. Database-enforced overlap keeps integrity under races | You set the confirmation period and the buffer, and whether travel to pick-up counts |
| DB-7 | **Missed confirmation or driver deadline (P-204)** | The booking is not confirmed. The shipper chooses between waiting and cancelling without charge, and both are recorded. Nothing is reassigned automatically | No automatic consequence is invented | Part of the terms (X-3) |
| DB-8 | **Cancellation (D-008)** | Before dispatch, either party may cancel with a reason code. Reservations are released at once. Release 1 charges no automatic fee: any compensation is a manual adjustment proposed by one staff member and approved by another (R-407). After dispatch, cancellation only through an operations case | The amounts and conditions need legal review; this structure lets the pilot run without inventing them | Lawyer (X-3) |
| DB-9 | **Dispatch authority (R-301)** | The carrier authorises dispatch. The server enforces the preconditions. Operations can block a dispatch, with a recorded reason | Fits the agent model (decision update, section 1) | — |
| DB-10 | **Tracking and the shipper's view (R-303, R-304, C-10)** | Milestones only in Release 1, with no live location collected. The shipper sees milestones and the latest stated arrival estimate | No location consent or retention rules are needed for launch | Can be revisited after the pilot |
| DB-11 | **Driver surface and offline working (D-004, REQ-OFF-01)** | Drivers use the web application on a phone, with no native app. When a driver cannot record, the carrier's dispatcher or operations records on the driver's behalf, with a reason and the stated time flagged as reported. The full offline queue is deferred | The smallest surface that completes the journey honestly | Your acceptance of the deferral |
| DB-12 | **POD review (R-401, R-402)** | The shipper's administrators accept or reject a POD explicitly, and silence never accepts it. Operations may accept on the shipper's behalf only with a recorded reason, after a period you set. Required POD items per delivery outcome are a fixed list | No silent legal effect is created | Lawyer (X-3) |
| DB-13 | **Delivery exceptions (R-406, DI-403)** | The driver records one outcome: delivered in full, delivered with remarks, partial, or refused. Anything except "in full" opens an operations case. Custody of remaining cargo is recorded. Resources are released only on the release condition | Covers refused and partial cargo without inventing who pays for return or storage | Insurance and legal (X-6) |
| DB-14 | **Disputes (R-403, R-404, R-405, DI-401)** | Either party may open a dispute on a booking. Each dispute creates its own hold on settlement eligibility. Staff mediate and record a decision; whether it binds the parties is for the terms. A hold is released only by its own case | The agent model makes mediation coherent (Part 4, section 10) | Lawyer: time limits, binding effect |
| DB-15 | **Reconciliation controls** | Every payment record has an owner, a bank reference, an amount and currency, and the evidence file. A record is reconciled only when a second staff member matches it to a statement line. Corrections are new records, never edits | Gives audit history and separation of duties | Accountant |
| DB-16 | **Operational closure** | A booking closes automatically only when all closure conditions hold; anything else waits in an operations queue with a named owner. Closure is recorded once | Keeps closure honest and checkable | — |
| DB-17 | **Pilot invitation** | Staff issue an invitation to a named organisation contact. Registration in production needs a valid invitation, and invitations expire and are audited | The smallest admission control | Pilot size and duration (D-012) are yours |
| DB-18 | **Launch country and lanes (D-003b, D-003c)** | Not recommended here. Your earlier options stand: L2 domestic first, then L1 Oman–UAE | Not chosen automatically, per your instruction | Yours |

## 6. Release-blocking defects and gates

| Item | State |
|---|---|
| SEC-01 | Fixed in PR #17, unmerged. Lock-removal and check-removal defects are each caught |
| Production gates (database TLS and certificates, failed-statement logging, pooler, settings review, console network restriction and CSP, staff sign-in limit per address, sole-administrator recovery) | Open; most depend on hosting (X-7) |
| Slice-4 unexplained API test failure; PR #9 staging CI diagnosis ("inferred") | Open investigations; to be closed before real use |
| Development-default settings | Need production review as one decision |

## 7. Next actions

1. You review and authorise merges for PRs #15, #16 and #17, in that order.
2. You answer DB-1 to DB-18; partial answers still unblock slices.
3. I build slice 13 (fleet and drivers) once its scope is approved. It can use fictional document types until X-5 is answered.
