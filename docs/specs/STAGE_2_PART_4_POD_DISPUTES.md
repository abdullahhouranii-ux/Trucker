# Trucker — Stage 2, Part 4: proof of delivery and disputes (provisional)

Version 0.2, 13 Nov 2026. Owner: Abdullah. Changes in 0.2: five open design issues from review recorded in section 13; where they conflict with sections 2 to 6, section 13 prevails until those sections are rewritten. Builds on the Stage 1 baseline, Stage 2 Part 1 (v0.3), Part 2 (v0.3) and Part 3 (v0.2). Authoritative copy: `docs/specs` in the repository; Claude-project copies are synchronised references.

**Status.** Provisional design; nothing is implemented and no application tests were run. D-001 (commercial model), D-002 (payment approach) and D-003 (launch geography) remain **TBD**. The review and dispute flow drafted here is **agent-shaped** (Trucker stands between a shipper and a carrier or owner) and must be redrawn if principal is chosen, because Trucker would then be a party to the shipper's claim. No fees, refunds, invoices or settlements are calculated; this part records the facts those later steps need. Liability, claims periods, evidence standards and retention need legal and insurance review. No supplier is selected.

## 1. Surfaces in this part

All seven surfaces remain in scope.

| Surface | Role in this part |
|---|---|
| A. Public website | Explains how delivery is evidenced and how a dispute is raised and handled, once the rules are approved |
| B. Shipper portal | Views POD, accepts it or raises a dispute, submits evidence, follows the outcome |
| C. Carrier portal | Views POD, uploads a paper POD on the driver's behalf with a reason, raises or answers disputes |
| D. Vehicle-owner portal | Same as carrier for the owner's own bookings |
| E. Driver application | Captures POD, including without a connection; reports delivery problems. Drivers do not raise or argue disputes |
| F. Operations console | Reviews POD where the rule requires it, runs disputes, records decisions, proposes adjustments; finance staff approve adjustments |
| G. Partner integration | Reads POD status and, for the organisation's own bookings, a short-lived link to the files; receives signed notifications of POD and dispute changes |

## 2. Separate state models

| Object | States | Notes |
|---|---|---|
| **Delivery outcome** | `delivered_in_full`, `delivered_with_remarks`, `partly_delivered`, `refused`, `not_delivered` | Recorded with the POD; anything other than the first opens an exception (Part 3, section 8) |
| **POD** | `not_captured` → `captured` → `uploaded` → `under_review` → `accepted`; or `more_evidence_requested`, `disputed` | Versioned; a correction is a new version, never an edit |
| **Dispute** | `raised` → `acknowledged` → `evidence_open` → `under_review` → `decided` → `closed`; optional `appealed`; or `withdrawn` | One dispute per subject on a booking; several may exist |
| **Adjustment record** | `proposed` → `approved` or `rejected` | A non-financial record of what should change; applying it to money is finance (not designed) |
| **Settlement hold flag** | `none`, `held` | A fact on the booking that finance must respect. It moves no money and does not mean anything was paid |

## 3. Journey J8a: POD capture

| Aspect | Specification |
|---|---|
| Actors and permissions | The assigned driver, on a trip that has reached `at_delivery`. A dispatcher of the operating controller, or operations, may upload a paper POD on the driver's behalf with a reason; it is marked as such |
| Fields | Delivery outcome; receiver's name and role; receiver's signature on screen, or a photo of a signed and stamped document; photos of the delivery note and of the cargo where relevant; quantity delivered and remarks; receiver's remarks (damage, shortage); time; position only if location consent is granted (Part 3, section 6) |
| Integrity | Each file gets a fingerprint when captured and again on receipt; they must match. Files are stored privately. Nothing is edited after capture; a replacement is a new POD version with a reason, and earlier versions stay visible to reviewers |
| Offline | Capture works without a connection and is stored durably on the device. Files upload resumably when a connection returns. The POD follows the event, stream and time rules of Part 3, section 5, including unverified times |
| Validation | At least one evidence item; outcome chosen; receiver name present unless the outcome is `not_delivered`; file type and size limits; the recorder holds the current assignment |
| Failure paths | Receiver absent or refuses to sign (outcome recorded, exception opened, operations instructs the driver); upload fails (retried; the trip shows "POD pending upload", never "no POD"); wrong or unreadable photo (new version); device lost before upload (dispatcher uploads the paper copy; operations reconciles); driver in restricted trip mode (capture stays available for that trip only) |
| Notifications | POD received to the shipper and the operating controller; POD pending upload to the dispatcher after a threshold; outcomes other than full delivery to operations |
| Audit events | `pod.captured`, `pod.uploaded`, `pod.version_added`, `pod.uploaded_on_behalf`, `pod.integrity_failed` |
| Acceptance | AT-401 a POD captured in flight mode uploads once after reconnecting, with its original capture time. AT-402 a file whose fingerprint differs on receipt is refused and reported. AT-403 a new POD version leaves earlier versions readable by reviewers. AT-404 a driver not holding the current assignment cannot add a POD. AT-405 a POD file cannot be opened by an organisation outside the booking or through an expired link |

## 4. Journey J8b: POD review

| Aspect | Specification |
|---|---|
| Who reviews | **Approved rule TBD (R-401)**, dependent on D-001: the shipper alone, operations alone, or operations first and the shipper second. Drafted here: the shipper reviews, with operations able to review on request or where an exception exists |
| Decisions | `accepted`; `more_evidence_requested` (states what is missing; not a dispute); `disputed` (opens a dispute under section 5 with the POD attached) |
| Review period and silence | Whether silence for a set period counts as acceptance, and how long that period is, is an **approved rule TBD (R-402)** with legal review. Until approved, nothing is accepted by silence |
| Validation | Only a user permitted to commit the shipper (Part 2, P-207) or staff with the operations privilege may decide; a decision names the POD version it applies to; a decision on a superseded version is refused |
| Effects | `accepted`: the trip is closed for delivery purposes and this fact is available to finance. Acceptance of a POD is **not** payment, settlement or confirmation that funds moved. Resource occupancy ends when the trip is delivered and the resource is free, not when the POD is accepted (Part 2, 7.3) |
| Failure paths | Reviewer loses permission before deciding (another permitted user decides); two reviewers decide at once (the first saved stands; the second is refused); evidence requested and not supplied by a deadline (operations case) |
| Notifications | Decision to both parties; evidence request to the operating controller and driver; approaching end of the review period to the reviewer |
| Audit events | `pod.review_opened`, `pod.accepted`, `pod.more_evidence_requested`, `pod.disputed`, each with reviewer, time and POD version |
| Acceptance | AT-411 a user without the commit permission cannot accept or dispute a POD. AT-412 two simultaneous decisions leave exactly one recorded. AT-413 without an approved silence rule, no POD becomes accepted by the passage of time. AT-414 accepting a POD changes no payment or settlement state. AT-415 every staff view of a POD file is recorded |

## 5. Journey J10a: disputes

The slice 18c implementation follows the separate-hold model in DI-401. Both contracting organisations must explicitly accept one immutable proposal version to record agreement. Operations facilitates and records the facts and recommendations. Abdullah approved manual release on 19 November 2026. An authorised staff administrator records a reason and releases only the owning hold after either both contracting organisations accept the same proposal version or the claimant withdraws without a counterclaim. Administrative closure or a reported external decision leaves the hold active. Under the counterclaim rule approved on 20 November 2026, an agreement supports release only if the accepted version explicitly records settlement terms for the counterclaims and was sent after the latest recorded counterclaim. See [the implementation record](../delivery/DISPUTES_SLICE_18C.md) for the local behaviour and pending policy work.


| Aspect | Specification |
|---|---|
| Who may raise | A permitted user of the shipper, or of the carrier or owner, on their own booking. Operations may open one on a party's behalf with a reason. Drivers report exceptions; they are not parties to a dispute |
| Subjects | Damage; shortage; non-delivery; late delivery; waiting-time claim; validity of the POD; a cancellation and its consequences; conduct |
| Time limit to raise | **Approved rule TBD (R-403)** with legal and insurance review |
| Fields | Booking; subject; description; amount or quantity claimed, if any (recorded, not adjudicated here); evidence files; the POD version and trip events relied on |
| Evidence | Each side submits within a period; submissions are versioned and cannot be edited or removed. Trip events are taken with their effective times after reconciliation (Part 3, 5.4); unverified times are shown as such. Each side sees the other's submissions unless staff restrict an item for a recorded reason |
| Who handles and decides | Operations coordinates evidence and mediation. Both contracting organisations explicitly accept the same proposal version to record agreement. External authority is governed by R-404. |
| Decision | The case records an agreement, withdrawal, administrative closure, or reported external decision and its reference. An agreement preserves proposed obligations for later processing under section 7. |
| Appeal | A later dispute can link to a closed case and retain its history. Any formal challenge or appeal procedure requires approved terms. |
| Settlement hold | Create an independent hold for a financial dispute. Record the disputed amount or item when known and scope under review when undecided. An active hold restricts settlement eligibility within its scope. Release requires the owning case, its recorded authority, a reason, and the independent permission defined under R-405. |
| Failure paths | Reject a stale proposal response or a revoked authority at mutation time. Record silence and elapsed time without changing agreement or releasing a hold. R-403 governs future opening windows. |
| Notifications | Every step to both parties; deadlines approaching; decision and appeal outcome |
| Audit events | `dispute.raised`, `dispute.acknowledged`, `dispute.evidence_submitted`, `dispute.evidence_restricted`, `dispute.decided`, `dispute.appealed`, `dispute.appeal_decided`, `dispute.withdrawn`, `dispute.closed`, `booking.hold_set`, `booking.hold_released` |
| Acceptance | AT-421 authorisation is checked against the booking and active privileges. AT-422 evidence is immutable. AT-423 separate holds release independently on an eligible recorded basis. AT-424 agreement requires the same proposal version and both parties. AT-425 related cases preserve prior history. AT-426 the timeline preserves the actor, time and authority for each result. |

## 6. Journey J10b: cancellation after dispatch and failed deliveries

| Aspect | Specification |
|---|---|
| How it happens | Only through an operations intervention case (Part 1, 3.7). No party can cancel a moving trip by a button |
| Facts recorded | Who asked and why; the trip state reached; whether cargo was loaded; where the cargo is; the times and places of the events relied on; the booking's policy snapshot |
| Cargo custody | If cargo is on the vehicle, the case cannot close without a custody record: returned to the shipper, delivered to another place, or handed to a replacement vehicle. Each handover is evidenced like a POD (who gave, who received, when, where, photos) |
| Failed delivery | Outcomes `refused`, `not_delivered` and `partly_delivered` open an operations case and a cargo case (R-406, decided 18 November 2026, 11:23; built in slice 18d). Who may instruct is recorded on the booking (the contracting customer when it declares that its contract gives it the right, or the organiser under an explicit mandate naming the actions); the receiver can refuse but gains no right to instruct. The carrier offers what is feasible and its costs; nothing is carried out before the authorised party approves, except a protective action in the booking's emergency plan after the response time, within its cap. Silence is never approval. Who pays for now is recorded at approval; who finally bears a cost is recorded only from the contract, a settlement or a competent decision. Trucker never decides liability. See `docs/delivery/UNDELIVERABLE_SLICE_18D.md` |
| Resources | Reservations are released and occupancy ends only when operations confirms the truck, trailer and driver are free (Part 2, 7.3) |
| Fees and refunds | Not calculated. The record holds the facts needed to apply the approved policy (D-008) |
| Audit events | `trip.aborted`, `custody.handover_recorded`, `booking.cancelled_after_dispatch`, plus the intervention events |
| Acceptance | AT-431 a trip with loaded cargo cannot be closed as aborted without a custody record. AT-432 a custody handover has a giver, a receiver, a time and evidence. AT-433 resources of an aborted trip stay occupied until operations confirms they are free |

## 7. Adjustment records

| Aspect | Specification |
|---|---|
| Purpose | To state what a decision changes: for example a waiting-time claim recognised, a shortage recognised, a cancellation consequence. It is a record for finance, not a movement of money |
| Who proposes | The staff member deciding a dispute or closing an intervention case |
| Who approves | Finance staff. The approver must be a different person from the proposer. Thresholds above which a second approver is needed are parameters within an approved rule (R-407) |
| Fields | Booking; cause (dispute or case); what changes; amount and currency if any, in the booking's currency and precision; evidence relied on |
| Effects | An approved adjustment is available to the finance journey, which is not designed until D-001 and D-002. The booking's agreed amount and terms snapshot are never rewritten; an adjustment sits beside them |
| Audit events | `adjustment.proposed`, `adjustment.approved`, `adjustment.rejected` |
| Acceptance | AT-441 the proposer of an adjustment cannot approve it. AT-442 an adjustment never alters the booking's agreed amount or terms snapshot. AT-443 an adjustment cannot be approved by staff without the finance privilege |

## 8. Waiting-time claims (C-22)

Arrival and departure times at each site come from trip events with their effective times after reconciliation. The platform can show the waiting duration and the evidence behind it. Whether a waiting-time claim is raised as a dispute, as a request the other party accepts, or automatically, and what is charged, is an **approved rule TBD** under D-008. Unverified times are excluded until reconciled (Part 3, 5.3).

## 9. Approved rules and operating parameters in this part

A setting holds a value inside an approved rule; it does not replace the rule.

**A. Approved rules required (your decision, review where noted, and tests)**

| ID | Rule |
|---|---|
| R-401 | Who reviews a POD (depends on D-001). Built in slice 18b with the shipper's administrators only (E-1, PD-3), for approval |
| R-402 | Whether silence accepts a POD, and the legal effect of acceptance (legal review) |
| R-403 | Time limits for raising each kind of dispute (legal and insurance review) |
| R-404 | Who decides a dispute and whether the decision binds the parties (depends on D-001; legal review) |
| R-405 | Scope of the settlement hold (with D-002 and D-008) |
| R-406 | Handling of refused and undelivered cargo. **Decided** 18 November 2026 (11:23) for development and testing; values are development defaults (UD-1 to UD-10 in `UNDELIVERABLE_SLICE_18D.md`) |
| R-407 | Approval structure for adjustments |
| D-008 | Cancellation and waiting-time policy |
| R-305 | Retention of POD files and dispute evidence (Part 3; legal review) |

**B. Operating parameters (within the rules, changed with history)**

Review period length, if R-402 sets one; evidence and appeal periods; "POD pending upload" threshold; file size limits; adjustment thresholds within R-407.

## 10. Where D-001, D-002 and D-003 change this part

Illustrative only; the final rules follow the approved contracts and professional review.

| Decision | Effect |
|---|---|
| **D-001 Commercial model** | Under an agent arrangement Trucker typically stands between the two parties, so a mediated dispute between shipper and carrier is coherent. Under a principal arrangement the shipper's claim would be against Trucker, with a separate matching claim by Trucker against the carrier; Trucker cannot neutrally decide a claim against itself, so review, decision authority and appeal must be redesigned. POD capture, integrity, custody records and evidence handling do not change |
| **D-002 Payment approach** | Decides what the hold flag acts on (a provider payout, an invoice due date, or nothing automatic) and when acceptance of a POD makes a booking eligible for settlement. Eligibility is never the same as confirmed movement of funds |
| **D-003 Geography** | Cross-border work adds customs and border documents to delivery evidence, and may bring different claims periods and document requirements per country |

## 11. Requirements and traceability

| Requirement | Summary | Carry-over items | Tests |
|---|---|---|---|
| REQ-POD-01 | POD capture with integrity, versions and offline support | — | AT-401 to AT-405 |
| REQ-POD-02 | POD review by a permitted reviewer; no acceptance by silence without an approved rule | C-23 (invoice record on POD approval: finance, not designed) | AT-411 to AT-415 |
| REQ-DIS-01 | Disputes with immutable evidence, recorded decisions and one appeal | C-25 (scorecards, deferred) | AT-421, AT-422, AT-424 to AT-426 |
| REQ-DIS-02 | Settlement hold flag set by a dispute and released only by a recorded act | C-38 (payment terms awaiting decision) | AT-423 |
| REQ-CAN-02 | Post-dispatch cancellation through an intervention case with cargo custody records | C-05 | AT-431 to AT-433 |
| REQ-ADJ-01 | Adjustment records with separate proposer and finance approver | C-05 | AT-441 to AT-443 |
| REQ-WTG-01 | Waiting duration derived from reconciled trip evidence | C-22 | Part 3 AT-314, AT-329 |

The 39-item carry-over register in the Stage 1 baseline is unchanged.

## 12. Stage 2 position after Part 4

| Area | Position |
|---|---|
| Parts 1 to 4 | Drafted and provisional. Journey J9 (invoice, payment, reconciliation) is not designed; it waits for D-001 and D-002 |
| Foundation-only setup | Repository structure, configuration, database connectivity and CI can proceed; it waits for no decision |
| Holds under either commercial model | Identity, organisations, verification, the four ownership relationships, shipment publication, reservations and occupancy, trip events and offline rules, tracking and consent mechanics, POD capture and integrity, evidence handling, custody records |
| Gated on D-001 | Quotation and acceptance parties, booking agreements, price fields, substitution consent, dispatch authority, POD reviewer, dispute decision authority |
| Gated on D-002 or D-008 | Payment conditions, settlement hold scope, cancellation and waiting-time consequences |
| Gated on legal, safety or insurance review | Driver multi-affiliation, intervention options, location consent and retention, silence rule, claims periods |

## 13. Open design issues recorded from review (13 Nov 2026)

These are not yet designed in full. Each states the correction, the direction to be taken and what it supersedes. They must be closed, with tests, before any of this part is implemented. The Stage 3 data model already follows the stated directions.

| ID | Issue | Direction | Supersedes |
|---|---|---|---|
| DI-401 | **Settlement holds must be separate records, not one flag on the booking.** Several disputes can coexist, and closing one must not release another's hold | One hold record per cause, each with: the booking; its owner (the dispute or intervention case that created it); its scope (whole booking or a stated part: rule R-405); who placed it; and its own state `active` → `released`. Only a recorded decision, withdrawal or closure of the **owning** case can release it, by staff with the authority set in R-404 and R-407. The booking is "held" while at least one hold is active; that is a derived fact, never stored as a switch. Tests to add: two disputes on one booking, closing the first leaves the second hold active; a hold cannot be released by a case that does not own it; release records who and why | The "settlement hold flag" in sections 2 and 5, and AT-423 |
| DI-402 | **POD needs an explicit completion manifest.** The server cannot know that a capture made entirely offline exists | The device declares a manifest for each POD version: the list of required and optional items with their identifiers. Server-side states are distinguished: **not received** (no manifest has reached the server; the trip shows only that delivery evidence is awaited), **upload incomplete** (manifest received, one or more required items missing), **ready for review** (every required item received and checked against the manifest). A POD cannot be reviewed or accepted unless it is ready for review; missing required files block acceptance. Which items are required per delivery outcome is an approved rule. Tests to add: acceptance refused while a required item is missing; the three states are shown distinctly; an item not on the manifest is not attached | The POD states in section 2 and "POD pending upload" in section 3 |
| DI-403 | **Recording `delivered` does not by itself free resources.** With partial delivery, refused cargo or cargo still in custody, the truck, trailer and driver may still be committed | Occupancy ends only on an explicit **resource-release condition**, recorded per resource: delivery outcome is `delivered_in_full` (or `delivered_with_remarks` with nothing left on the vehicle) **and** no cargo remains in custody; or custody records show all the remaining cargo handed over **with the receiving side's receipt confirmed** (an unconfirmed handover moves nothing), or delivered on a completed leg; or operations confirms release in a case. While a further leg of the trip (retry, another destination, return) is under way, no resource of the trip is released by anyone (corrected by R-406, slice 18d). Until then the resources stay occupied and the next booking's dispatch stays blocked. Parts 2 (7.3), 3 (section 3) and this part are to be reconciled around one release rule and one test set | "until the trip is delivered" in Part 2, 7.3; "Resource occupancy ends when the trip is delivered" in section 4; the "delivered and trip closed" row of Part 2, 7.3 |
| DI-404 | **Restricted-driver POD access is inconsistent.** Section 3 lets a driver in restricted trip mode capture POD; the allowlist in Part 1, 3.7 does not include it | To be decided explicitly as an approved rule, as one allowlist used by every part. Proposed for your decision: in restricted trip mode the driver may record milestones and capture POD for the current trip (write only), and may view only the instructions operations issues; the driver may not view earlier evidence, other parties' documents or the trip thread. For a compromised account nothing is available and POD is captured by the dispatcher or operations on behalf. Until decided, restricted trip mode is as written in Part 1 and POD capture is on behalf | The "driver in restricted trip mode" clause in section 3 |
| DI-405 | **A matching file fingerprint shows the file arrived unchanged, not that the delivery happened as stated** | The fingerprint is described and displayed only as transfer integrity. What supports a POD is its provenance: who recorded it, under which assignment, on which device and stream, at what recorded and received times, with what position if consented, whether recorded on behalf, and the full review and version history. No screen, export or notification presents a fingerprint as proof of delivery. Reviewers see provenance and any unverified time beside the evidence | The "Integrity" wording in section 3 and AT-402's implication |
