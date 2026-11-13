# TruckLink Plan B — implementation plan
Version 0.1 · Draft for Abdullah · 13 November 2026
Basis: repaired Plan B Urdu prototype and original PLAN_B_ARCHITECTURE.md.
Status: planning assumptions; repository, staffing, provider contracts and existing implementation have not been inspected.
Approval owner: Abdullah. Engineering, operations, QA, finance and security owners: TBD.

## 1. Delivery recommendation
Build one real booking-to-delivery journey first, then expand. Keep the approved architecture direction: NestJS modular monolith, PostgreSQL/PostGIS, Next.js portal/operations console, Flutter mobile, Redis/BullMQ and private object storage. Reuse an existing repository if one exists; do not start a competing implementation.

For the earliest controlled pilot, propose responsive web access for all five roles and one Flutter driver application. Shipper, carrier and owner Flutter experiences follow after the pilot unless Abdullah confirms native apps for every role are required at first launch. This is a proposed sequencing change, not an approved scope reduction. Preserve every role's business capabilities in the final target.

The HTML is a visual and workflow reference, not production source architecture. Its browser-memory settings, role switcher, identities and simulated transactions must not become production authentication or accounting. Keep the repaired offline HTML intact for demonstrations. The production platform requires hosted services; only designated mobile workflows operate offline.

## 2. Scope boundaries
Pilot Must:
- Real sign-in, account recovery, staff MFA, organisations and scoped memberships.
- Five roles; Operations split into dispatch, compliance, support, finance and configuration privileges.
- Shipper load creation; eligible carrier/owner search; offers and optional counteroffers; offer acceptance.
- Atomic booking and compatible truck/trailer/driver reservation with document and availability checks.
- Driver assignment, milestones, consented location updates, cached trip, offline event queue and POD.
- Operations verification, POD approval, disputes, controlled cancellation and exception handling.
- Per-trip messaging, shipment history and notifications with real adapters or explicitly disabled integrations.
- Contracted payment terms, financial records and reconciliation. Live collection/disbursement only after approved provider integration; a separately approved manual-invoice pilot is possible.
- Persisted admin settings, financial change approvals, audit history and rollback.
- English, Arabic and Urdu, including RTL, translated validation/status text and reviewed critical actions.
- Backups, observability, support runbooks and release/rollback procedures.

Should after a stable pilot:
- Remaining Flutter role experiences, enhanced fleet tools, richer operations reports.
- One selected enterprise integration and partner sandbox.
- Expanded tracking/map features and notification channels.

Defer unless explicitly required:
- Broad ERP connector catalogue, AI matching, subscriptions, rewards, lending, insurance products, microservices and sophisticated route optimisation.
- Odoo dependency: Plan B is independent. Confirm whether Odoo is needed for accounting or another integration; do not add it as a mandatory transaction dependency by assumption.

## 3. Decisions needed early
| ID | Decision | Proposed working assumption | Required before |
|---|---|---|---|
| DEC-001 | Existing repo and infrastructure | Inspect first; retain working implementation | First code changes |
| DEC-002 | First launch surfaces | Five-role web + Flutter driver; remaining mobile later | Scope baseline |
| DEC-003 | Pilot market, lanes, cargo and exclusions | Oman as in source; exact operators/lanes TBD | UAT dataset |
| DEC-004 | Operating entity and commercial model | No unapproved custody of funds | Production transactions |
| DEC-005 | Hosting/residency/retention | Local development until approved hosting | Production data |
| DEC-006 | Identity, payment, maps and notifications vendors | Interfaces and test adapters while undecided | Relevant live features |
| DEC-007 | Fees, taxes, cancellation, disputes and settlement policy | Versioned draft policy; no invented legal/tax rules | Financial UAT |
| DEC-008 | Language reviewers, devices, pilot users and sign-off owners | Named reviewers required | UAT |
| DEC-009 | Target load, availability and recovery objectives | Measure baseline; propose targets for approval | Performance/recovery gate |

Abdullah decides commercial scope and suppliers; nominated operations/finance owners validate their processes. Engineering owns design and delivery evidence. QA owns independent acceptance evidence. AI-generated code requires human review.

## 4. Milestones and exit evidence
Effort is not a guaranteed date. First produce a repository gap assessment and sized backlog. Illustrative planning envelope for a small experienced delivery team: 6–10 weeks to a constrained pilot, then additional releases for the full mobile/integration scope. A solo developer plus Claude Code should not treat that envelope as a commitment. Vendor onboarding and approvals can dominate the calendar.

| Phase | Sequence / indicative effort | Deliverable | Exit evidence |
|---|---|---|---|
| M0 | First 1–2 working days | Repo audit, scope map, runnable environment, decisions/backlog | Existing vs missing capabilities evidenced; one clean setup; owners assigned |
| M1 | Next 3–5 days | Walking skeleton: sign-in → create load → persisted list → role-controlled read | Real database round-trip; tenant and authorization tests; CI green |
| M2 | Next 5–10 days | Offers → accepted booking → reserved resources → dispatch | Race test proves one winner; expired/incompatible assets blocked; retry idempotency |
| M3 | Next 5–10 days | Driver mobile, milestones, messaging, tracking and POD | Airplane-mode/reconnect test; no duplicate event effect; POD review and dispute workflows |
| M4 | Next 5–10 days | Finance, settings, provider sandbox, reconciliation, basic integration boundary | Duplicate/reordered webhook tests; auditable settings approvals; reconciliation report |
| M5 | Next 5–10 days | Language review, security/recovery/performance checks, UAT and training | Signed critical journeys; restore evidence; no unresolved critical/high defects |
| M6 | Controlled pilot and stabilization | Limited users/lanes, monitored real operations, support handover | Daily reconciliation; incident triage; expansion decision based on agreed KPIs |

These are ordered work packages; some UI/mobile preparation can overlap after the API contract stabilises. Do not add the ranges mechanically to promise a launch date. Re-estimate after M0 and after the first complete booking journey.

First ten working days:
1. Audit and setup; confirm schema, dependency versions, authentication approach and launch surfaces.
2. Add executable environment setup, seed data, health/readiness checks and CI.
3–4. Complete identity, tenant membership and one real shipper create/list journey.
5. Demonstrate the persisted journey with EN/AR/UR UI scaffolding.
6–8. Implement offers, booking transaction and resource reservation, then wire carrier/owner web actions.
9. Prove concurrent booking rejection and compliance enforcement.
10. Demonstrate shipper → carrier/owner → operations dispatch, publish evidence and update the forecast.
If the repository is already mature, skip completed work and advance to the first unmet gate.

## 5. Functional and technical backlog
| Requirement | Work and implementation rule | Acceptance evidence |
|---|---|---|
| REQ-001 Identity/tenancy | Users, organisations, memberships, invitations, revocation, ownership/delegation, privileged MFA | TC-001 tenant A cannot read/write tenant B, including files, sockets and exports; intentional marketplace projections are explicit |
| REQ-002 Profiles/compliance | Licence/permit/insurance metadata, expiry, private uploads, review decisions | TC-002 expired or unverified required documents block dispatch; authorised renewal re-enables it |
| REQ-003 Loads/offers | Draft/publish, equipment/cargo/window, quote/counteroffer/expiry, immutable accepted price | TC-003 valid carrier offer accepted once; stale or unauthorised offers rejected |
| REQ-004 Booking/dispatch | Atomic acceptance + booking + reservations; capacity, authorisation, compatibility, timezone-aware windows | TC-004 simultaneous conflicting reservations yield one success; no partial booking; adjacent valid windows allowed |
| REQ-005 Trips/offline | Server-controlled transitions, event IDs, device sequence, occurred/received times, explicit sync conflicts | TC-005 duplicate/reordered/offline batches preserve one effect and reject invalid transitions |
| REQ-006 Tracking/POD | Permission-aware location, freshness indicator, signed private evidence and reviewer decision | TC-006 assigned driver only; failed upload retry safe; POD approval/dispute visible in history |
| REQ-007 Messaging/alerts | Participant-only threads, safe text rendering, notification preferences, durable retries | TC-007 outsider cannot subscribe; reconnect retrieves history without duplicate messages |
| REQ-008 Finance | Monetary decimals/minor units, currency precision, obligations, provider events, adjustments, reconciliation | TC-008 duplicate webhook no double posting; disputes block eligibility; provider-confirmed result required for settled state |
| REQ-009 Settings | Server storage, validated bounds, permission scopes, versions, dual approval for financial settings, rollback | TC-009 unauthorised save rejected; audit shows before/after; existing bookings retain their agreed policy snapshot |
| REQ-010 Language/accessibility | Shared keys, EN/AR/UR, RTL layouts, locale-aware amounts/dates, keyboard labels | TC-010 reviewers sign critical journeys in all three languages; long text and validation usable |
| REQ-011 APIs/integrations | Versioned OpenAPI, scoped partner access, idempotency, signed webhooks and replay tooling | TC-011 timeout retry causes one effect; forged/replayed webhook rejected; exhausted delivery visible to support |
| REQ-012 Operations/release | Health, logs without secrets, backups/restore, migrations, import templates, runbooks | TC-012 restore and rollback rehearsed; seeded pilot data reconciled; support receives ownership |

Core records: user, organisation, membership, profile, asset/vehicle, trailer, driver affiliation/delegation, compliance document and review, shipment, offer/version, booking, resource reservation, trip, trip event, location sample, conversation/message, POD evidence/review, dispute, payment attempt/provider event, finance obligation/adjustment, settlement, reconciliation run/item, setting version/approval, integration client, outbox and audit event.
Use explicit source-of-truth boundaries. A payment provider owns confirmed movement of funds; TruckLink owns bookings, policy snapshots and internal obligations. Any later ERP adapter has a documented mapping and replay-safe identifiers.

## 6. Critical design rules
- Enforce permissions on the server and on each resource, not through hidden UI controls.
- Validate tenant relationships and foreign keys; expose only approved marketplace data across organisations.
- Enforce booking overlaps in the database, with transactional resource reservation and concurrency tests; avoid application-only availability checks.
- Model shipment, offer, trip, POD and payment states separately. Define allowed actors, preconditions and side effects for every transition.
- Use an outbox for transaction-linked jobs, idempotent consumers, bounded retries and visible failures. Redis alone is not the transaction source of truth.
- Private object storage, short-lived signed access, file type/size validation and malware handling policy.
- Accept offline driver observations through idempotent APIs; the server remains authoritative. Do not promise exactly-once network delivery.
- Preserve historical prices, currency, fee policy and relevant settings on bookings; new settings must not silently rewrite old contracts.
- Retention, location consent, residency and legal/payment requirements require qualified approval; this plan asserts no specific compliance status.

## 7. Risks, assumptions, issues and dependencies
Risks: RISK-001 supplier approval delays; RISK-002 launch surface expansion; RISK-003 reservation races; RISK-004 offline duplicate events; RISK-005 payment mismatch; RISK-006 translation errors in critical actions.
Mitigation: lock pilot scope, start onboarding immediately, test invariants early, reconciliation and review gates before real transactions.

Assumptions: ASSUMPTION-001 Plan B remains the chosen direction; ASSUMPTION-002 a reviewer and pilot users are available; ASSUMPTION-003 web-first pilot sequencing is acceptable pending confirmation.

Issues: ISS-001 production repository/current implementation unknown; ISS-002 vendors, budget, staffing and launch date unconfirmed. The HTML blank-page defect is repaired; it does not demonstrate production readiness.

Dependencies: DEP-001 repo access and environments; DEP-002 approved vendors and credentials; DEP-003 commercial/legal/payment policies; DEP-004 translated copy review; DEP-005 pilot assets, documents and users.

## 8. Launch, cutover and definition of done
Before release: passing critical requirements/tests, human review, no unresolved critical/high defects, approved pilot scope, production credentials configured securely, backup restore rehearsed, monitoring/alerts working, support trained, signed UAT, rollback owner and release approval.
Import master data with templates and validation; do not migrate fictional prototype identities/transactions into production. Rehearse a clean installation before merge/release.
Start with limited approved users and lanes. Reconcile finance daily, triage exceptions daily, record incident owners and assess expansion only after the agreed stabilization criteria.
Done means working UI + real API + durable data + permissions + relevant automated tests + operational evidence. Mocked UI, a screenshot or a passing build alone is not completion.

## 9. Technical references
- PostgreSQL exclusion constraints and range types support database-enforced non-overlap: https://www.postgresql.org/docs/15/rangetypes.html
- Flutter offline-first architecture patterns: https://docs.flutter.dev/app-architecture/design-patterns/offline-first
- NestJS queue integration: https://docs.nestjs.com/techniques/queues
These references inform the design; versions must be selected against the actual repository and verified before implementation.

