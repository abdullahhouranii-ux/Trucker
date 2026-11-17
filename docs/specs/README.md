# Trucker specifications

This folder is the single authoritative set of Trucker specifications.
Copies kept in the Claude project are synchronised references; if they differ, this folder wins.
Change a specification here first, then synchronise the reference copy.

All documents are provisional. What is built, with its evidence, is recorded slice by slice in `docs/delivery` (slices 1 to 16 on 17 November 2026; slices 11 to 16 on open pull requests). Part 4's unresolved policies (section 13) stay gated.
Commercial model: ADR_001_COMMERCIAL_MODEL.md (agent; organiser commission included in the shipping price; Trucker's fee paid before confirmation). Launch geography (D-003) is undecided.

| Document | Version | Covers |
|---|---|---|
| STAGE_1_BASELINE.md | 0.1 | Vision, platform and role matrix, journeys, scope, carry-over register (39 items), decision register |
| STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md | 0.3 | Identity, organisations, verification, ownership relationships, interventions, permissions |
| STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md | 0.3 | Shipment publication, quotation, acceptance, booking, reservation, substitution, occupancy |
| STAGE_2_PART_3_DISPATCH_TRACKING_EXCEPTIONS.md | 0.2 | Assignment, dispatch authorisation, trip events, offline rules, tracking and consent, exceptions |
| STAGE_2_PART_4_POD_DISPUTES.md | 0.2 | Proof of delivery, review, disputes, post-dispatch cancellation, adjustment records. Five open design issues (DI-401 to DI-405) in section 13 |
| STAGE_3_ARCHITECTURE.md | 0.4 | Recommended architecture, modules, data relationships, permission enforcement, offline synchronisation, environments, foundation backlog |
| ADR_001_COMMERCIAL_MODEL.md | 0.2 | The revised commercial model: participants and shipment roles, organiser commission, Trucker's fee and confirmation, financial settings, settlement. Confirmed requirements, proposed defaults and open decisions are marked. Where it differs from an earlier document, it wins |

Not yet written: the detailed payment, settlement and reconciliation specification (phases four and five of ADR-001).

Foundation-only setup (repository structure, configuration, database connectivity, CI) waits for no decision.
Booking implementation and operational policies stay gated on the approved rules listed in each part.
