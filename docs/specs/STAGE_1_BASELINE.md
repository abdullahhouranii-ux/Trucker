# Trucker — Stage 1 baseline (provisional)

Version 0.2, 13 Nov 2026. Owner and decision maker: Abdullah. Changes in 0.2: regional direction confirmed (F-08 to F-11); D-003 split into D-003a to D-003e and D-014 added; assumption A-02 corrected; section 7.3 replaced. Detail: REGIONAL_GEOGRAPHY.md.
Status: **provisional**. Nothing here is approved unless it sits under "Confirmed". Items marked **TBD** are waiting for a decision. Legal, tax, licensing and payment points need qualified review; this document claims no compliance.

## 0. Evidence: what was inspected

| Source | Inspected? | Finding |
|---|---|---|
| GitHub `abdullahhouranii-ux/Trucker`, branch `main`, commit `d8107af` | Yes, read in full except the prototype's script body | 9 files, documents only: `README`, `AGENTS.md`, `docs/delivery/STATUS.md`, `BACKLOG.md`, and four reference files (Plan B architecture, draft implementation plan, a Claude Code handoff prompt, the repaired prototype HTML). **No API, portal, mobile, database, test or CI code exists.** |
| Prototype HTML in the repository | Structure only | An offline demonstration with simulated data in OMR. Not a production application; not run or tested here. |
| TruckLink project documents (7) | Yes | Used as the source for the carry-over register in section 5. |
| TruckLink application code and Odoo databases | **Not inspected** | Not needed; no code is carried over. |

Repository notes to fix at the first real commit: the files sit in a nested `Trucker/` folder; the README still says nothing was committed; `STATUS.md` speaks of five roles and omits the public website and partner surface.

## 1. Product vision and business objectives

**Vision.** Trucker is one connected freight marketplace and transport management platform where shippers get verified road transport booked, tracked and documented, and carriers, vehicle owners and drivers get work, clear instructions and reliable settlement records, in English, Arabic and Urdu.

**Problems addressed.**
- Shippers: finding verified capacity, comparing prices, knowing where the cargo is, getting proof of delivery and a clean invoice.
- Carriers and owners: finding loads, avoiding empty running, proving delivery, knowing what they are owed and when.
- Drivers: clear trip tasks in their own language that still work with poor connectivity.
- The operator: verification, dispatch oversight, disputes and finance under separated, audited privileges.

**Business objectives.** Targets are **TBD** until the commercial model and pilot limits are decided.

| # | Objective | Measure | Target |
|---|---|---|---|
| O1 | Complete real bookings end to end | Bookings delivered with approved POD | TBD |
| O2 | Trusted supply | Verified carriers, owners, trucks and drivers | TBD |
| O3 | Reliable execution | On-time pick-up and delivery rate; exception rate | TBD |
| O4 | Clean money records | Bookings reconciled without manual correction | TBD |
| O5 | Revenue | Per the commercial model (decision D-001) | TBD |
| O6 | Usable in three languages | Critical journeys signed off by human reviewers in EN, AR, UR | All critical journeys |

## 2. Platform and role matrix

**Surfaces (full target, all retained).**

| Surface | Users | Form | Launch timing |
|---|---|---|---|
| A. Public website | Everyone | Next.js, multilingual | TBD (D-004) |
| B. Shipper portal | Shipper organisations | Responsive web; native app in target | TBD (D-004) |
| C. Carrier portal | Carrier companies | Responsive web; native app in target | TBD (D-004) |
| D. Vehicle-owner portal | Independent owners | Responsive web; native app in target | TBD (D-004) |
| E. Driver application | Drivers | Flutter, offline-capable | TBD (D-004) |
| F. Operations console | Trucker staff | Web | TBD (D-004) |
| G. Partner integration | Shipper ERP, carrier TMS | API, sandbox, webhooks; dedicated portal TBD | TBD (D-004) |

**Roles and what each may do.** ✔ = own organisation's records only; ◐ = limited or assigned records only; — = no access. All permissions are enforced on the server.

| Capability | Shipper admin / user | Carrier admin / dispatcher | Vehicle owner | Driver | Ops dispatch | Compliance | Support | Finance | Security / config |
|---|---|---|---|---|---|---|---|---|---|
| Organisation, users, locations | ✔ | ✔ | ✔ (own profile) | — | view | view | view | view | — |
| Fleet, trailers, driver links | — | ✔ | ✔ owned or authorised assets | ◐ own documents | view | review | view | — | — |
| Verification decisions | — | — | — | — | — | ✔ decide | — | — | — |
| Create and publish shipments | ✔ | — | — | — | assist | — | assist | — | — |
| Discover loads, submit offers | — | ✔ | ✔ | — | view | — | view | — | — |
| Accept offer, book | ✔ | — | — | — | assist | — | — | — | — |
| Assign truck, trailer, driver | — | ✔ | ✔ | — | oversee, override TBD | — | — | — | — |
| Trip milestones, POD capture | view | view | ◐ if driving | ✔ assigned trips | view | — | view | — | — |
| POD review | ✔ accept or dispute | view | view | — | ✔ | — | — | — | — |
| Messaging on a trip | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | — |
| Invoices, earnings, settlement records | ✔ own | ✔ own | ✔ own | ◐ TBD | — | — | view | ✔ | — |
| Disputes | raise | raise | raise | report exception | triage | — | ✔ handle | ✔ adjustments | — |
| Financial settings | — | — | — | — | — | — | — | propose **or** approve, never both on one change | propose **or** approve |
| Integrations, API clients | request | request | — | — | — | — | view | — | ✔ |
| Audit history | — | — | — | — | view | view | view | view | ✔ |

Rules already fixed by the brief:
- A vehicle owner is not a carrier company. An owner who drives holds both the owner and driver roles on one identity; an owner who delegates authorises named drivers per vehicle. Neither receives carrier-company permissions automatically.
- A driver's link to a carrier or owner is an explicit affiliation record with start, end and who authorised it.
- Staff privileges are separated (operations, support, compliance, finance, security) and staff sign in with MFA.
- Possible extra roles, both **TBD**: a read-only regulator login (raised by the Oman licence reference) and partner API clients with scoped access.

## 3. Main end-to-end journeys

Each journey gets full detail (fields, permissions, notifications, audit events) in Stage 2. Separate state models are kept for shipment, offer, booking, trip, POD and finance.

| # | Journey | Normal sequence | Key exceptions | Offline | Acceptance criterion (summary) |
|---|---|---|---|---|---|
| J1 | Registration and verification | Sign up, create or join organisation, upload documents, compliance review, verified | Rejected or expired document; duplicate organisation; invitation expired | — | Unverified parties cannot book or be dispatched; every decision is audited |
| J2 | Shipment creation and publication | Draft, cargo, equipment, locations, time windows, publish | Invalid window; excluded cargo; edit after offers exist | — | A published shipment is visible only to eligible, verified supply |
| J3 | Load discovery and offer | Search or be matched, view allowed details, submit offer with validity | Offer expired; carrier loses eligibility | — | Offers visible only to the shipper and the offering party |
| J4 | Negotiation and acceptance | Counter-offer (rounds TBD), accept one, others closed | Simultaneous acceptance; stale offer | — | Exactly one offer can be accepted; price is fixed at acceptance |
| J5 | Booking and reservation | Acceptance creates the booking and reserves resources in one transaction | Truck, trailer or driver already reserved; document expires before pick-up | — | Two overlapping reservations of one resource can never both succeed |
| J6 | Assignment and dispatch | Assign truck, trailer, driver; driver acknowledges | Driver declines; reassignment; breakdown before start | Assignment cached on device | Only compatible, verified, available resources can be assigned |
| J7 | Pickup, transit, exceptions | Arrive, load, depart, transit, arrive; location with consent | Delay, damage, refusal at site, breakdown | Milestones queued and replayed | A replayed or late event has one effect; invalid transitions are rejected |
| J8 | Delivery and POD | Capture POD, upload, review, accept or dispute | Upload fails; POD rejected; receiver absent | Capture offline, upload later | POD is stored privately; review decision is recorded with reviewer and time |
| J9 | Invoice, payment, reconciliation | Records created from approved POD; payment confirmed; reconciled | Short payment; duplicate provider event; currency rounding | — | "Settlement eligible" is never shown as "paid"; duplicate events post once |
| J10 | Dispute, cancellation, adjustment | Raise, evidence, decision, adjustment record | Cancellation after dispatch; waiting-time claim | Driver exception report queued | An open dispute blocks settlement eligibility; fees follow the booking's own policy snapshot |

## 4. Full target scope versus recommended pilot

The right-hand column is **my recommendation only**. None of it is approved, and nothing is removed from the target.

| Area | Full target | Recommended pilot | Status |
|---|---|---|---|
| Geography | Middle East, prioritising the six GCC countries (confirmed, F-08) | Initial countries and lanes are open (D-003b, D-003c); no recommendation is made here | Target confirmed; launch TBD |
| Commercial model | TBD | See decision D-001 | TBD |
| Payments | Provider collection, payouts, reconciliation | See decision D-002 | TBD |
| Surfaces | All seven, plus native apps for shipper, carrier and owner | Website, three responsive portals, operations console, driver app; partner API and other native apps in later releases | TBD (D-004) |
| Participants | Shippers, carriers, owners who drive, owners who delegate, drivers | All, including delegation, because it shapes the permission model early | Recommended |
| Pricing | Fixed price, quotation, negotiation | Quotation with limited counter-offers; fixed price later when rate history exists | TBD (D-005) |
| Cargo and equipment | Full catalogue | General dry cargo on flatbed, curtain-side and box; chilled, liquids, dangerous goods, oversize and livestock held back for permit and insurance checks | TBD (D-006) |
| Languages | EN, AR, UR with RTL | All three from the first screen | Confirmed requirement |
| Accounting | Optional ERP adapter (Odoo possible) | Export files first; adapter later | Recommended |

## 5. Carry-over register from TruckLink reference material

Historical TruckLink decisions are **not** Trucker policy. Status meanings: **Proposed** = I recommend including it in the Trucker baseline; **Confirm** = needs your decision before it enters or leaves scope; **Defer** = I recommend keeping it in the target but after the first release. Nothing is marked excluded; that status is applied only after you decide.

| ID | Item from reference | Status | Note |
|---|---|---|---|
| C-01 | Truck and trailer as separate assets; equipment catalogue | Proposed | Needed for reservation integrity |
| C-02 | Corridor and border-crossing catalogue | Proposed as reference data | Which lanes are switched on depends on D-003 |
| C-03 | Three pilot lanes (Muscat–Sohar–Dubai, Muscat–Salalah, Muscat–Riyadh/Dammam) | Confirm | Two of the three cross a border |
| C-04 | Principal model, or agent/principal per contract | Confirm | Decision D-001 |
| C-05 | Commercial terms and cancellation fees editable in admin settings | Proposed | Under two-person approval; bookings keep their snapshot |
| C-06 | Sign-in by phone one-time code with the platform's own sessions | Proposed | Staff MFA and account recovery added |
| C-07 | Providers behind interfaces until chosen | Proposed | |
| C-08 | Vendor shortlist: Unifonic, HERE or OpenStreetMap with own routing server, Tap, Thawani, Google Cloud Doha | Confirm | Maps choice changed during TruckLink; all need re-verification with the vendors |
| C-09 | Hosting inside the Middle East only | Confirm | Oman data-residency answer from counsel still open |
| C-10 | Mandatory fixed GPS device on every truck | Confirm | Raises the onboarding barrier for small owners |
| C-11 | Document wallet with expiry reminders | Proposed | Supports "expired documents block dispatch" |
| C-12 | Per-trip messaging | Proposed | In the brief |
| C-13 | Driver-to-driver chat | Confirm | Moderation and safety duties |
| C-14 | Urgent help button | Confirm | No police integration; emergency number dial only |
| C-15 | Road radio (walkie-talkie by corridor) | Confirm; I recommend defer | Needs a real-time audio service, moderation and a driving-safety review |
| C-16 | Voice control in three languages | Defer | Vendor quality for Urdu and Gulf Arabic unproven |
| C-17 | Automatic step detection by geofence | Defer | After basic milestones work |
| C-18 | Return-load finder; post an empty truck | Defer | Strong value once there is load volume |
| C-19 | Live queue times; delay prediction; road hazard reports | Defer | Need fleet density first |
| C-20 | Chat translation | Defer | Vendor needed |
| C-21 | Share-tracking link for the receiver | Proposed | Expiring, single trip |
| C-22 | Waiting-time evidence from arrival and departure times | Proposed | Charges depend on approved terms |
| C-23 | Invoice record created on POD approval | Proposed | Without the Odoo dependency |
| C-24 | Driver earnings statement | Proposed | Content depends on who pays the driver (TBD) |
| C-25 | Driver work record ("driver passport"); scorecards both ways | Defer | Need trip history |
| C-26 | Price guide; best-match assignment; fraud checks; fuel and CO2 report | Defer | Need data volume |
| C-27 | Truck hire with or without driver | Confirm | A different product with its own licence question |
| C-28 | Reward points, profile questions, invite-a-friend | Confirm | The repository's draft plan lists rewards as "defer" |
| C-29 | Wage advance, remittance, insurance offers | Confirm; I recommend defer | Only through licensed partners, after legal advice |
| C-30 | Roadside network; rest and food stops | Defer | Need signed partners |
| C-31 | Data business (selling aggregated market data; offers to drivers) | Confirm | Changes consent design, terms and possibly licensing |
| C-32 | Extended driver profile (family, food, housing, remittance habits) | Confirm | Tied to C-31 |
| C-33 | Consent ledger with separate optional permissions | Proposed | Needed for location consent regardless of C-31 |
| C-34 | Registration terms draft (driver, company, privacy) | Proposed as a lawyer's starting draft | Several clauses depend on D-001 |
| C-35 | Oman smart-application licence path; regulator read-only login | Confirm | Counsel and ministry to confirm current requirements |
| C-36 | Odoo finance integration | Defer | Optional adapter only (confirmed) |
| C-37 | "Road-sign plain" visual direction and font set | Confirm | Candidate for the Trucker design system |
| C-38 | Payment terms options: prepaid, deposit plus POD, POD-approved | Confirm | From the Plan B architecture reference |
| C-39 | Partner API pattern: scoped credentials, signed webhooks, idempotency keys, sandbox | Proposed | In the brief |

## 6. Decision register

**Confirmed facts**

| ID | Fact |
|---|---|
| F-01 | Trucker is a fresh implementation, separate from TruckLink; no TruckLink code is copied |
| F-02 | TruckLink materials are requirements and design references only |
| F-03 | Full target platform retained: public website, shipper, carrier, vehicle owner, driver, operations, partner integrations |
| F-04 | English, Arabic and Urdu, including RTL |
| F-05 | Core is independent of Odoo |
| F-06 | Mandatory requirements, **not yet implemented**: two-person financial approval, reservation integrity, secure offline synchronisation |
| F-07 | Repository contains documents only (section 0). Superseded: foundation code now exists; see docs/delivery/STATUS.md |
| F-08 | Trucker targets the Middle East, prioritising the six GCC countries: Oman, UAE, Saudi Arabia, Qatar, Kuwait and Bahrain. The platform is not scoped as Oman-only |
| F-09 | The platform is designed for country-specific configuration: international phone numbers, currencies, named time zones, document requirements, domestic routes and cross-border journeys including transit countries |
| F-10 | Adding a country is not assumed to be only a matter of catalogue rows |
| F-11 | The business base is a separate decision (D-014) from launch countries and routes. Business registration and launch-market permissions are separate |

**Open decisions**

| ID | Decision | My recommendation | Blocks |
|---|---|---|---|
| D-001 | Commercial model | Section 7.1 | Finance design, terms, licensing questions |
| D-002 | Payment approach | Section 7.2 | Finance module depth, provider onboarding |
| D-003a | Full target geography | **Confirmed:** Middle East, six GCC countries first (F-08) | — |
| D-003b | Initial enabled countries | None; GCC-wide and phased options are set out in REGIONAL_GEOGRAPHY.md | Tax, currency, documents, vendors, support |
| D-003c | Initial domestic and cross-border lanes, including transit countries | None | Lane configuration, border documents and milestones |
| D-003d | Participant eligibility by country | None | Registration, verification matrix |
| D-003e | Country launch dependencies | Readiness record per country (REGIONAL_GEOGRAPHY.md, section 6) | Enabling any country |
| D-004 | Launch surfaces and order | Web portals plus driver app first | Build order after the foundation |
| D-005 | Pricing mechanism | Quotation with limited counter-offers | Offer state model details |
| D-006 | Cargo, equipment and exclusions | Dry general cargo first | Catalogue and verification rules |
| D-007 | Operating legal entity | TBD | Contracts, licence, provider onboarding |
| D-008 | Cancellation, waiting-time and refund policy | TBD, lawyer review | Journey J10, terms |
| D-009 | Who pays the driver and what a driver sees of money | TBD | Earnings screens |
| D-010 | Support model and hours | TBD | Operations console, runbooks |
| D-011 | Suppliers: hosting, SMS/OTP, maps, storage, push | Interfaces now, choose before live use | Production |
| D-012 | Pilot limits and success measures | TBD | Section 1 targets, performance gate |
| D-013 | Carry-over items marked "Confirm" | Section 5 | Scope |
| D-014 | Business base | **Preferred direction recorded 13 Nov 2026:** Dubai, UAE, with a free-zone company. The specific free zone is undecided and nothing is registered | Legal entity (D-007), contracts, provider onboarding |

**Assumptions in use until you say otherwise**

| ID | Assumption |
|---|---|
| A-01 | The reference stack is the starting point for Stage 3 evaluation: Next.js, Flutter, NestJS modular monolith, PostgreSQL/PostGIS |
| A-02 | Every organisation, location and booking carries country, currency and a named time zone. This keeps the data model open to several countries; it does not make a country launchable. Each country also needs rules, integrations, content and a readiness review (REGIONAL_GEOGRAPHY.md, sections 6 and 7) |
| A-03 | Money is stored in minor units with per-currency precision (OMR uses three decimal places) |
| A-04 | The commercial model and policy version are stored on each booking as a snapshot |
| A-05 | Platform-held money is never called escrow |

## 7. The three decisions that shape architecture and operations

D-001 and D-002 are **TBD**. D-003 is split: the target geography is confirmed; initial countries, lanes and eligibility are **TBD**. The tables in this section are **illustrative comparisons, not findings**: payment deadlines, price visibility, liability, invoicing and tax treatment must follow approved contracts and professional legal and accounting review. The recommendations are not approvals.

### 7.1 D-001 Commercial model

| | Agent (commission) | Principal (buy and sell transport) | Both, chosen per contract |
|---|---|---|---|
| Contract | Shipper and carrier contract directly; Trucker charges a fee | Shipper contracts with Trucker; Trucker subcontracts the carrier | Two contract paths |
| Trucker's revenue | Commission | Margin between shipper price and carrier price | Mixed |
| Credit and cash exposure | Low: limited to unpaid commission | High: Trucker owes the carrier even if the shipper pays late | Mixed |
| Cargo liability | Mainly the carrier's (lawyer to confirm) | Trucker faces the shipper as carrier (lawyer to confirm) | Both sets |
| Licensing questions | Platform licence | May also need a goods-transport licence | Both |
| Accounting weight | Light: commission invoices | Heavy: full receivables, payables and tax on gross value | Heaviest |
| Control of price and customer | Lower | Higher | Mixed |
| Build cost | Lowest | Higher | Highest: every finance flow and test doubled |

**Recommendation:** launch as **agent**, and keep the model as a field on the booking snapshot so principal can be added later without rework. It limits financial exposure while volumes are unproven and keeps the core free of an accounting system. If owning the customer relationship and margin matters more to you than exposure, choose principal and accept an earlier accounting integration.

### 7.2 D-002 Payment approach

| | Recorded only, paid by bank transfer | Provider collects and splits to the carrier | Trucker collects in full and pays out |
|---|---|---|---|
| Money through Trucker's accounts | None | Commission only | All of it |
| Regulatory exposure | Lowest | Carried largely by the licensed provider | Highest; may need payment licensing outside a true principal model |
| Dependency | None | Provider onboarding and contract | Bank and treasury processes |
| Operations effort | Manual matching by finance staff | Automated, with exception handling | Payout runs, treasury, reconciliation |
| User experience | Familiar for B2B on credit terms | Best for spot jobs and small carriers wanting fast payout | Single counterparty for both sides |
| Fits commercial model | Either | Agent | Principal |

**Recommendation:** build the finance module **provider-ready from the start** (payment attempts, verified webhooks, replay protection, reconciliation), go live on **recorded bank transfers**, and start provider onboarding in parallel so collection with split payout can be switched on when the contract and legal review are done. Card fees on freight-sized invoices were reported at roughly 2 to 3 percent in the reference research; that figure needs re-checking with providers.

### 7.3 D-003 Geography and D-014 business base

Revised 13 Nov 2026. The earlier comparison and my recommendation to launch "Oman domestic" are **withdrawn**.

| Part | Status |
|---|---|
| D-003a Full target geography | **Confirmed:** Middle East, prioritising the six GCC countries |
| D-003b Initial enabled countries | **TBD** |
| D-003c Initial lanes, including transit countries | **TBD** |
| D-003d Participant eligibility | **TBD** |
| D-003e Country launch dependencies | Framework in REGIONAL_GEOGRAPHY.md; content needs qualified review |
| D-014 Business base | Preferred direction: Dubai, UAE, with a free-zone company. Specific free zone **TBD**. Not a registration instruction |

A company registered in one country is not thereby permitted to operate transport, platform or payment activities in another. The full treatment, including named time zones and transit-country checks, is in `REGIONAL_GEOGRAPHY.md`.

## 8. Dependencies, risks and acceptance criteria

**Dependencies**

| ID | Dependency | Owner |
|---|---|---|
| DEP-01 | Decisions D-001 to D-003 | Abdullah |
| DEP-02 | Lawyer review: contracting model, terms, liability, privacy and consent, licence | Abdullah to appoint |
| DEP-03 | Accountant review: tax treatment, invoicing, revenue recognition | Abdullah to appoint |
| DEP-04 | Supplier accounts and sandbox credentials | After D-011 |
| DEP-05 | Human reviewers for Arabic and Urdu | TBD |
| DEP-06 | Delivery capacity: who writes, reviews and tests code | TBD; no estimate is given until this is known |
| DEP-07 | Pilot shippers, carriers, owners and drivers | TBD |

**Risks**

| ID | Risk | Mitigation |
|---|---|---|
| R-01 | Scope grows before one journey works end to end | Vertical slices; carry-over register with explicit status |
| R-02 | Licensing or payment rules differ from assumptions | Early legal review; no live money before sign-off |
| R-03 | Double booking of a truck, trailer or driver | Database-enforced non-overlap, concurrency tests from the first booking slice |
| R-04 | Duplicate or late offline events corrupt trip state | Event identifiers, server-authoritative transitions, replay tests |
| R-05 | Records show "paid" when money has not moved | Separate states; provider-confirmed result required |
| R-06 | Translation errors on critical actions | Human review gate for EN, AR, UR |
| R-07 | Supplier approval lead times delay launch | Start onboarding as soon as D-011 is made |
| R-08 | Reference material treated as approved policy | This register; decisions recorded only when you make them |

**Measurable acceptance criteria.** Thresholds marked TBD are set with D-012.

| ID | Criterion |
|---|---|
| AC-01 | A user of one organisation cannot read or change another organisation's records, files or messages (negative tests for every role) |
| AC-02 | In a test of simultaneous conflicting bookings, exactly one succeeds and no partial booking remains |
| AC-03 | A driver completes pick-up, delivery and POD in flight mode; after reconnecting, each event is applied once and in a valid order |
| AC-04 | A financial setting cannot be approved by the person who proposed it; a stale approval cannot overwrite a newer setting; existing bookings keep their terms |
| AC-05 | A duplicated or replayed provider event produces one posting; a forged event is rejected |
| AC-06 | Expired or unverified required documents block dispatch |
| AC-07 | Every critical journey passes in EN, AR and UR with human reviewer sign-off, including RTL and mixed-direction identifiers |
| AC-08 | A backup is restored and a migration rehearsed before release |
| AC-09 | Response times and volumes meet the agreed pilot figures (TBD) |
| AC-10 | Stage 1 is complete when D-001 to D-006 are decided, every carry-over item has a status you have set, and this baseline is reissued without TBD in sections 4 and 7 |

## 9. Recommended implementation sequence

Complete vertical slices, each with UI, API, database, permissions and tests. No dates are given until scope and delivery capacity are known.

| Step | Slice | Can start before D-001 to D-003? |
|---|---|---|
| S0 | Foundation: repository layout, API, database migrations, web shell, configuration, health checks, CI, three-language scaffolding | Yes |
| S1 | Sign-in, organisations, memberships, scoped roles, staff MFA; shipper creates and lists a shipment; tenant-isolation tests | Yes |
| S2 | Carrier and owner profiles, documents, verification, fleet, driver affiliation and delegation | Yes |
| S3 | Offers, negotiation, acceptance, atomic booking and reservation with concurrency tests | Mostly; price and fee fields wait for D-001 |
| S4 | Driver app: assignment, milestones, consented location, offline queue, messaging, POD capture and review | Yes |
| S5 | Disputes, cancellation, finance records, settings with two-person approval, reconciliation | No: needs D-001, D-002, D-008 |
| S6 | Public website content, partner API and sandbox, optional accounting export | Website yes; commercial pages wait for D-001 |
| S7 | Language review, security review, restore and performance evidence, user acceptance, training | After the slices above |
| S8 | Controlled pilot, monitoring, stabilisation; remaining native apps and deferred items | After release approval |

## 10. Work continuing now without those decisions

1. Stage 2 journey detail for J1 to J8: fields, permissions, exceptions, notifications, audit events and acceptance tests.
2. Separate state models for shipment, offer, booking, trip and POD.
3. The ownership, delegation and affiliation model for vehicle owners and drivers.
4. Information architecture and low-fidelity layouts for one public page, the shipper shipment workflow, one operations screen and one driver task.
5. A corrected repository layout and S0 specification for developers.
