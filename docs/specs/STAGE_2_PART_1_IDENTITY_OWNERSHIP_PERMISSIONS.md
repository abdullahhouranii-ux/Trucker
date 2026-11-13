# Trucker — Stage 2, Part 1: identity, organisations, ownership and permissions (provisional)

Version 0.4, 13 Nov 2026. Owner: Abdullah. Changes in 0.4: the D-003 row in section 8 is revised for the regional direction (REGIONAL_GEOGRAPHY.md). Changes in 0.3: suspended-driver access narrowed and a separate response defined for compromised accounts or sessions (3.7); affiliation rule no longer described as a setting. Changes in 0.2: sections 3.5 to 3.9 rewritten after review (causes of ending kept separate, operations-controlled interventions, evidence-backed ownership disputes, provisional driver affiliation). Builds on "Trucker - Stage 1 baseline (provisional)".

**Status.** Provisional design. Nothing here is implemented. D-001 (commercial model) and D-002 (payment approach) remain **TBD**; D-003 has a confirmed target geography (Middle East, GCC first) with initial countries, lanes and eligibility **TBD** (REGIONAL_GEOGRAPHY.md); section 8 shows where each changes this part. No supplier is selected and no legal compliance is asserted. Document types, licence names and employment rules need legal and transport-sector review.

**Stage 2 parts.** 1 Identity, organisations, ownership, permissions (this document). 2 Shipment publication, quotation and booking with resource reservation. 3 Dispatch, tracking and exceptions. 4 POD and disputes. Finance journeys wait for D-001 and D-002.

## 1. Surfaces and roles

Surfaces are places where people work; they do not create roles. All seven remain in scope.

| Surface | Who uses it in this part | What it does here |
|---|---|---|
| A. Public website | Visitors | Explains participation; entry to registration and sign-in. No role of its own |
| B. Shipper portal | Shipper members | Organisation onboarding, users, locations |
| C. Carrier portal | Carrier members | Organisation onboarding, fleet, driver affiliation, authorisations |
| D. Vehicle-owner portal | Owners and their delegated managers | Ownership, delegation, driver authorisation |
| E. Driver application | Drivers | Registration, documents, accept or end affiliations, see authorisations |
| F. Operations console | Staff | Verification decisions, conflict resolution, suspensions, audit |
| G. Partner integration | A member's own systems | Acts **as an organisation** through a scoped API client; never more access than the organisation has |

## 2. Core concepts

| Concept | Definition |
|---|---|
| **User** | One real person with one sign-in identity. A person can hold several roles (for example owner and driver) on the same identity |
| **Organisation** | A commercial participant: a company, or a one-person owner account. Holds verified **capabilities**, not a single type |
| **Capability** | What a verified organisation may do: `ship`, `carry_as_company`, `offer_owned_vehicles`. Granted only by a compliance decision |
| **Membership** | A user's role inside an organisation: `admin`, `dispatcher`, `finance`, `member` (names provisional) |
| **Driver profile** | A user's verified right to drive: identity and licence. Exists independently of any organisation |
| **Asset** | A truck or a trailer, each a separate record (C-01) |
| **Staff account** | A Trucker employee with one or more privilege sets: operations, compliance, support, finance, security. Never a member of a customer organisation |
| **API client** | A credential issued to an organisation with a named subset of that organisation's permissions |

An independent vehicle owner is an organisation with only `offer_owned_vehicles`. It does **not** receive `carry_as_company`: it cannot take on other people's vehicles, run a team of dispatchers or affiliate drivers as a company unless it is separately verified as a carrier.

## 3. Four relationships, kept separate

These are four different records. None implies another.

| | 3.1 Vehicle ownership | 3.2 Delegated management | 3.3 Carrier affiliation | 3.4 Driver authorisation |
|---|---|---|---|---|
| Question answered | Who legally owns this asset? | Who may run this asset on the owner's behalf? | Under which organisation does this driver work? | May this driver drive this asset? |
| Between | Asset and owning organisation | Asset (or all assets of an owner) and a delegate: a user or a carrier organisation | Driver profile and an organisation with `carry_as_company` or `offer_owned_vehicles` | Driver profile and an asset, or all assets under one operating controller |
| Created by | Owner claims; compliance verifies against the registration document | Owner proposes; delegate accepts | Either side invites; the other accepts | The operating controller (see below) |
| Scope options | — | `manage_documents`, `offer_and_book`, `assign_drivers`, `view_earnings` (each granted separately) | None; whether several affiliations are allowed is an approved rule (see 3.9) | Single asset or all; optional end date |
| States | `claimed` → `verified` / `rejected`; `ended`. Competing claims: see 3.8 | `proposed` → `active` → `revoked` / `expired` / `ended` | `invited` → `active` → `suspended` → `ended` | `active` → `revoked` / `expired` |
| Key fields | Asset, owner, evidence document, valid from, valid to, verified by | Asset or owner-wide flag, delegate, scopes, valid from, valid to, granted by | Driver, organisation, relationship kind (employee, contractor: **TBD legal**), start, end, ended by | Driver, asset or controller-wide flag, granted by, valid from, valid to |
| Ends when | Sale or transfer recorded; ownership rejected | Owner or delegate revokes; end date; ownership ends | Either side ends it; staff suspension | Controller revokes; affiliation ends; licence expires; ownership or delegation behind it ends |

**3.5 Operating controller: what it does and does not do.** At any moment one party holds commercial control of an asset: the verified owner, or the single delegate holding an active `offer_and_book` delegation. The database must prevent two overlapping active `offer_and_book` delegations on one asset.

This rule only stops two parties from selling the same asset. It does **not** make an asset or a driver available, and it replaces none of the following, each of which is checked separately:

| Check | Where defined |
|---|---|
| Time-based reservation of truck, trailer and driver without overlap | Part 2, reservation |
| Driver availability for the window (including other organisations' work) | Part 2, reservation |
| Trailer requirement, compatibility and documents | Part 2, booking |
| Dispatch authorisation before a trip may start | Part 3 |

**3.6 When may a driver be put forward for an asset?** All must hold for the whole booking window: driver identity and licence verified and valid; asset verified with valid documents; the assigning party is the operating controller; the driver is that party itself or has an active affiliation with it; an active driver authorisation covers the asset. Passing these makes the driver **eligible**. It is not an assignment: reservation, the driver's acknowledgement and dispatch authorisation still follow.

**3.7 Five different reasons a relationship stops, kept separate**

| Cause | Raised by | New offers and assignments | Bookings not yet started | Trip in progress |
|---|---|---|---|---|
| **Routine revocation** (a party ends a delegation, affiliation or authorisation by choice) | Owner, delegate, carrier or driver | Stop at the effective time | Flagged "needs reassignment"; deadline **TBD** (Q-103) | Operations is notified and confirms the handling; the proposed normal outcome is completion, but it is a recorded decision, not automatic |
| **Licence or document expiry** | System, from dates on verified documents | Blocked from the expiry time | Flagged at a lead time (**TBD**); dispatch refused while invalid | An intervention case opens before expiry where the dates allow; operations decides |
| **Safety suspension** | Operations or compliance staff, with reason | Blocked immediately | Held; reassignment required | Intervention case opens immediately; operations decides |
| **Suspected fraud** | Compliance or security staff | Blocked immediately | Held pending review | Intervention case opens immediately; evidence preserved; what the subject is told follows a policy that needs legal review (**TBD**) |
| **Disputed ownership** | A claimant, through the process in 3.8 | **No automatic effect** | No automatic effect | No automatic effect; restrictions only by a compliance decision |

No cause other than routine revocation carries a default outcome for a trip in progress, and even that default is confirmed by a person.

**Operations-controlled intervention**

| Aspect | Specification |
|---|---|
| Record | Intervention case: cause, subject, affected bookings and trips, evidence, decision, instructions sent, driver acknowledgement, outcome, staff member at each step |
| Until a decision | The trip's state is unchanged and it is flagged "under review". Target time to decide: **TBD** |
| Decision options | Allow to complete; continue to a named safe point; hold at a safe location; replace driver or vehicle; cancel. The list of permitted options per cause is a policy needing safety and legal review (**TBD**) |
| Who decides | Staff with the operations privilege. A safety or fraud suspension itself is set by compliance or security; the trip handling is decided by operations |
| Driver communication: operational suspension | Applies to suspension for documents, a safety review or a routine cause, where the account itself is trusted. The driver is placed in **restricted trip mode**: access to the current trip only (its instructions, messaging with operations, exception reporting, emergency contact details) until the trip is closed or handed over. No other trips, no history, no organisation data, no new work |
| Driver communication: compromised account or session | Applies where takeover, a stolen or shared device, leaked credentials or impersonation is suspected. **No app access is retained.** All sessions are revoked at once; anything submitted from a revoked session (milestones, location, messages) is rejected and kept aside for review. Operations reaches the driver outside the app, by a call to the number on record and through the carrier or owner, and runs the trip under an intervention case. Access returns only after re-authentication with an identity re-check by support. If the person's identity itself is in doubt, it is handled as suspected fraud and a safety matter |
| Choosing between the two | A recorded staff decision with a reason. In doubt, the compromised-account response applies |
| Instructions | Sent in the driver's language; never require interaction while driving; acknowledgement is recorded |
| Audit events | `intervention.opened`, `intervention.decision_recorded`, `intervention.instruction_sent`, `intervention.acknowledged`, `intervention.closed`; each with staff identity, time and reason |
| Notifications | Driver, operating controller, shipper where the delivery is affected, and the relevant staff queue |

**3.8 Ownership claims are evidence-backed disputes**

| Step | Rule |
|---|---|
| Submission | A claim on an asset already verified to another organisation must include evidence. It is recorded as `claim_submitted` and changes nothing for the current operator |
| Screening | Compliance checks the evidence. Missing or insufficient evidence: `rejected_unsupported`; the current operator is not disturbed |
| Review | A credible claim becomes `under_review`. The current owner is notified and given a response period (**TBD**) to submit evidence. The asset stays operable |
| Interim restriction | Only by a recorded compliance decision with a reason, for example strong evidence of sale or fraud indicators. Options: none, or no new offers. Trips in progress follow the intervention process |
| Decision | `upheld` (ownership record changes; existing bookings go through an intervention case) or `rejected`. Both parties are told the outcome and reason |
| Appeal | Either party may appeal once within a period (**TBD**). A different compliance reviewer decides. The platform decision does not replace a court or authority; wording needs legal review |
| Abuse | Repeated unsupported claims are flagged for compliance |

States: `claim_submitted` → `rejected_unsupported` or `under_review` → `upheld` or `rejected` → optional `appealed` → `appeal_upheld` or `appeal_rejected`.

**3.9 Driver affiliation with more than one organisation (provisional)**

Whether a driver may be affiliated with several organisations at once is **TBD** and needs legal review of employment and sponsorship rules. The design keeps three things separate so either answer works without rework:

| Thing | Meaning | Controlled by |
|---|---|---|
| Affiliation | A working relationship exists between a driver and an organisation | Both sides; whether one or several are allowed is an approved rule after legal review (**TBD**), not a setting |
| Permission to take an assignment | The driver may be put forward for a specific asset and then accepts a specific assignment | Driver authorisation (3.4), the driver's own acknowledgement, dispatch authorisation (Part 3) |
| Availability | The driver is free for the time window | Time-based reservation (Part 2), which refuses overlaps whichever organisation asks |

An affiliation alone never lets an organisation assign a driver, and several affiliations never allow overlapping work.

**Other rules**

| Situation | Proposed rule | Status |
|---|---|---|
| Ownership transferred by agreement while bookings exist | Needs compliance approval; affected bookings go through an intervention case | Proposed |
| Owner tries to act as a carrier company | Refused: capability `carry_as_company` is missing | Confirmed rule |

## 4. Journeys

Field lists are provisional. Document types come from a per-country catalogue that staff maintain; the catalogue content needs legal and sector review.

### J1.1 Personal registration and sign-in

| Aspect | Specification |
|---|---|
| Actors | Any person; staff are created separately by a security administrator |
| Fields | Mobile number (international format), name, preferred language (EN, AR, UR), acceptance of terms and privacy notice with document version |
| Method | Proposed: one-time code to the mobile number, then the platform's own session (C-06). Email sign-in for portal users: **TBD**. Staff: password plus MFA, mandatory |
| States | User: `pending` → `active` → `suspended` → `closed` |
| Validation | Number format; one account per number; code expiry and attempt limit; terms version recorded |
| Failure paths | Code not received (resend with cool-down, alternative channel); number already registered (go to sign-in); too many attempts (temporary lock); number changed or lost phone (recovery with identity re-check by support) |
| Notifications | Code message; "new sign-in on another device"; recovery started and completed |
| Audit events | `user.registered`, `user.terms_accepted`, `session.created`, `session.revoked`, `user.recovery_started`, `user.recovery_completed`, `user.suspended` |
| Acceptance | AT-101 a second account on the same number is refused. AT-102 after the attempt limit, further codes are refused for the lock period. AT-103 revoking sessions signs out every device at the next request. AT-104 staff cannot sign in without MFA |

### J1.2 Organisation onboarding

| Aspect | Specification |
|---|---|
| Actors | The registering user becomes the first `admin` |
| Fields | Legal name, trading name, country, registration number, requested capabilities, address, contact person, tax number (optional, per country), billing contact |
| States | Organisation: `draft` → `submitted` → `verified` / `changes_requested` / `rejected`; later `suspended`, `closed`. Each capability has its own state |
| Validation | Registration number unique per country; requested capability needs its required documents; the person submitting declares authority to bind the organisation |
| Failure paths | Duplicate registration number (offer "request to join" to the existing admins; no data about the existing organisation is shown); abandoned draft (reminder, then expiry: period **TBD**) |
| Notifications | Submitted, changes requested, verified, rejected, suspended |
| Audit events | `org.created`, `org.submitted`, `org.capability_requested`, `org.updated` (before and after values) |
| Acceptance | AT-111 an unverified organisation cannot publish a shipment, submit an offer or be assigned. AT-112 a duplicate attempt reveals nothing about the existing organisation |

### J1.3 Verification (organisation, asset, driver)

| Aspect | Specification |
|---|---|
| Actors | Applicant uploads; **compliance** staff decide. Operations, support and finance staff can view but not decide |
| Fields | Document type, number, issuing country, issue and expiry dates, file; decision, reason code, reviewer, time |
| States | Document: `uploaded` → `under_review` → `accepted` / `rejected`; `expiring`, `expired`. Subject becomes `verified` only when every required document is accepted |
| Validation | File type and size limits; expiry in the future; number format where known; files stored privately |
| Failure paths | Unreadable or wrong document (reject with reason, re-upload); suspected forgery (escalate, suspend subject); expiry (warn at lead times **TBD**, then mark expired and block new dispatch) |
| Notifications | Decision to applicant; expiry warnings to subject and its organisation admins; expiry to operations if a booking is affected |
| Audit events | `document.uploaded`, `document.viewed` (staff), `document.accepted`, `document.rejected`, `document.expired`, `subject.verified`, `subject.suspended` |
| Acceptance | AT-121 a staff member without the compliance privilege cannot record a decision. AT-122 a document file cannot be opened by a user of another organisation or by an unsigned link. AT-123 an expired required document blocks dispatch and renewal re-enables it |

### J1.4 Invitations and membership

| Aspect | Specification |
|---|---|
| Actors | Organisation `admin` invites; invited user accepts |
| Fields | Mobile number or email, role, optional expiry |
| States | Invitation: `sent` → `accepted` / `declined` / `expired` / `cancelled`. Membership: `active` → `suspended` → `ended` |
| Validation | Role must exist for the organisation's capabilities; an organisation always keeps at least one active admin |
| Failure paths | Invitation to a number with no account (registration first, then acceptance); last admin tries to leave (refused); member removed while signed in (access ends at next request) |
| Notifications | Invitation, acceptance, role change, removal |
| Audit events | `membership.invited`, `membership.accepted`, `membership.role_changed`, `membership.ended` |
| Acceptance | AT-131 a removed member's next request is refused. AT-132 a `dispatcher` cannot invite users or change roles. AT-133 the last admin cannot be removed |

### J1.5 Ownership, delegation, affiliation and authorisation

| Aspect | Specification |
|---|---|
| Actors | Owner admin; delegate (user or carrier admin); carrier admin or dispatcher; driver; compliance staff |
| Fields and states | As in section 3 |
| Validation | Rules of 3.5 to 3.9; a delegation cannot grant more than the owner holds; valid-from before valid-to; only one active `offer_and_book` controller per asset |
| Failure paths | Delegate declines; ownership claim (3.8); any of the five stop causes (3.7); driver declines an affiliation; authorisation requested for a driver with no affiliation (refused) |
| Notifications | Every proposal, acceptance, revocation and expiry to both sides; conflicts and affected bookings to operations |
| Audit events | `ownership.claimed`, `ownership.verified`, `ownership.claim_screened`, `ownership.claim_review_opened`, `ownership.interim_restriction_set`, `ownership.claim_decided`, `ownership.appealed`, `ownership.ended`, `intervention.*` (3.7), `delegation.proposed`, `delegation.accepted`, `delegation.revoked`, `affiliation.invited`, `affiliation.accepted`, `affiliation.ended`, `driver_auth.granted`, `driver_auth.revoked` |
| Acceptance | AT-141 an owner without `carry_as_company` cannot affiliate another owner's vehicle. AT-142 two overlapping `offer_and_book` delegations on one asset cannot both be saved, including under simultaneous requests. AT-143 after revocation, the former delegate cannot offer or assign the asset. AT-144 a driver without an active authorisation cannot be assigned to the asset. AT-145 an ownership claim without accepted evidence changes nothing about the asset's availability. AT-146 a routine end of affiliation clears assignments not yet started and opens an operations confirmation for a trip in progress. AT-147 an interim restriction on a claimed asset can be set only by compliance staff and requires a reason. AT-148 an appeal cannot be decided by the reviewer who made the original decision. AT-149 for expiry, safety suspension or suspected fraud, a trip in progress is neither ended nor allowed to continue without a recorded operations decision. AT-150 an operationally suspended driver with a trip in progress can read that trip's instructions and message operations, and cannot open any other trip, history or organisation data or accept new work. AT-155 when an account is marked compromised, every session is refused at the next request, including for the trip in progress, and later submissions from those sessions are rejected and held for review. AT-156 access after a compromise is restored only after a recorded identity re-check. AT-153 every intervention step appears in the audit history with staff identity, time and reason. AT-154 holding the operating-controller role does not bypass a reservation overlap |

### J1.6 Partner API client (surface G)

| Aspect | Specification |
|---|---|
| Actors | Organisation admin requests; security staff approve and issue |
| Fields | Client name, organisation, permitted scopes, sandbox or live, expiry |
| States | `requested` → `issued` → `rotated` / `revoked` / `expired` |
| Validation | Scopes are a subset of the organisation's capabilities; secrets shown once; live access only after sandbox use (criteria **TBD**) |
| Failure paths | Organisation suspended (client suspended with it); secret leaked (revoke and rotate) |
| Audit events | `api_client.requested`, `api_client.issued`, `api_client.rotated`, `api_client.revoked`, plus the same events as a human for each action taken |
| Acceptance | AT-151 a client cannot read anything its organisation's members could not. AT-152 a revoked client is refused at the next request |

Whether a dedicated partner portal is needed at launch stays **TBD** (D-004); the client record above is needed either way.

## 5. Permission model

- **Default deny.** Every request is checked on the server against the signed-in identity, the organisation context and the specific record.
- **Four scope kinds:** organisation (through membership), asset (through ownership or delegation), trip (assigned driver and the booking's parties), staff privilege.
- **No cross-organisation reads** except named marketplace projections: for example, an eligible carrier sees a published shipment's lane, equipment and window, not the shipper's contacts. Each projection is listed and tested.
- **A record that the requester may not see is reported as not found**, so its existence is not revealed.
- **Staff privileges are separate sets.** A staff member may hold several, but financial setting changes always need a second, different person.
- **Staff access to customer documents is itself audited.**
- **Suspension cascades downward:** suspended organisation, then its memberships, API clients and new offers; never silently upward.

## 6. Requirements and traceability

| Requirement | Summary | Carry-over items | Tests |
|---|---|---|---|
| REQ-ID-01 | One identity per person; sign-in, recovery, session revocation | C-06, C-07 | AT-101 to AT-104 |
| REQ-ID-02 | Terms and privacy acceptance recorded by version and language | C-33, C-34 | AT-101 |
| REQ-ORG-01 | Organisations with separately verified capabilities | C-35 (regulator login TBD) | AT-111, AT-112 |
| REQ-ORG-02 | Memberships and invitations | — | AT-131 to AT-133 |
| REQ-VER-01 | Document catalogue, review decisions, expiry handling | C-11, C-08 (storage supplier TBD) | AT-121 to AT-123 |
| REQ-AST-01 | Truck and trailer as separate assets | C-01 | AT-142, AT-145 |
| REQ-AST-02 | Fixed GPS device as a verification requirement | C-10: **awaiting your decision**; field reserved, rule not applied | — |
| REQ-OWN-01 | Ownership, delegation, affiliation, authorisation as four records | C-27 (truck hire, awaiting decision, would reuse delegation) | AT-141 to AT-144, AT-154 |
| REQ-OWN-02 | Ownership claims handled as evidence-backed disputes with appeal | — | AT-145, AT-147, AT-148 |
| REQ-OPS-01 | Stop causes kept separate; operations-controlled, fully recorded interventions; restricted trip communication for operational suspension; no access for compromised accounts | C-12 | AT-146, AT-149, AT-150, AT-153, AT-155, AT-156 |
| REQ-PRM-01 | Server-enforced tenant and record permissions; staff privilege separation | — | AT-112, AT-121, AT-122 |
| REQ-INT-01 | Scoped API clients | C-39 | AT-151, AT-152 |
| REQ-PRV-01 | Consent records for optional data and location | C-33; C-31 and C-32 awaiting decision, nothing collected until then | Part 3 |

The 39-item carry-over register in the Stage 1 baseline is unchanged. Items not listed above belong to later parts.

## 7. Open points in this part

| ID | Point | Proposed default |
|---|---|---|
| Q-101 | Sign-in for portal users: mobile code only, or email as well | Mobile code for everyone; email added as a second identifier for company users |
| Q-102 | May a driver hold affiliations with several organisations | **TBD**, legal review; design works either way (3.9) |
| Q-106 | Permitted intervention options per cause, decision time target, and what a subject is told in a fraud review | TBD with safety and legal review |
| Q-107 | Response and appeal periods for ownership claims | TBD |
| Q-103 | Deadline for reassigning bookings after a delegation is revoked | TBD with the cancellation policy (D-008) |
| Q-104 | Co-ownership of one vehicle | Not supported at first; one owning organisation per asset |
| Q-105 | Mandatory fixed GPS device (C-10) | Your decision |

## 8. Where D-001, D-002 and D-003 change this part

Only neutral placeholders are designed. No commercial or payment model is built.

| Decision | Effect on journeys | Effect on data model |
|---|---|---|
| **D-001 Commercial model** | Changes which terms each organisation accepts at onboarding (direct shipper-carrier contract plus a fee, or contracts with Trucker on both sides). Under principal, carriers and owners are onboarded as Trucker's suppliers and shippers may need a credit check and limit | `terms_acceptance` is generic (document, version, language, who, when). Credit limit and supplier agreement fields are **not** added until decided |
| **D-002 Payment approach** | Decides whether carriers and owners complete a payment provider's own identity checks during onboarding, or only supply bank details for invoices | A `payout_profile` placeholder linked to the organisation, with no fields yet |
| **D-003 Geography** (see REGIONAL_GEOGRAPHY.md) | Registration accepts mobile numbers in international format from any country. An organisation chooses its registration country from those enabled for registration. Document requirements are looked up by country and participant type. Four facts stay separate: the organisation's registration country, the driver's residence and licence country, the phone number's country (which grants nothing), and permission to operate on a route, which is verified per country including transit countries | Country is on organisation, document and asset. Phone numbers are stored with their country code. A country is configuration plus rules plus a readiness record, not only catalogue rows; enabled states (registration, booking, transit) are recorded per country |

## Appendix: repository housekeeping

The proposed root layout and exact diff are in `trucker-housekeeping-root-layout.patch`. The change is staged locally only; nothing is committed, merged or pushed without Abdullah's instruction.
