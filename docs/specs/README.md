# Trucker specifications

This folder is the single authoritative set of Trucker specifications.
Copies kept in the Claude project are synchronised references; if they differ, this folder wins.
Change a specification here first, then synchronise the reference copy.

All documents are provisional. Only foundation slice 1 is implemented and tested (docs/delivery/FOUNDATION_SLICE_1.md): workspace, configuration, health and readiness, migration runner. No business feature described in these documents is implemented. Part 4's unresolved policies (section 13) stay gated.
Commercial model (D-001) and payment approach (D-002) are undecided. The target geography is confirmed as the Middle East, prioritising the six GCC countries; initial countries, lanes and participant eligibility (D-003b to D-003d) are undecided. The preferred business base (D-014) is a Dubai free-zone company; the specific free zone is undecided and nothing is registered.

| Document | Version | Covers |
|---|---|---|
| STAGE_1_BASELINE.md | 0.2 | Vision, platform and role matrix, journeys, scope, carry-over register (39 items), decision register |
| STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md | 0.4 | Identity, organisations, verification, ownership relationships, interventions, permissions |
| STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md | 0.4 | Shipment publication, quotation, acceptance, booking, reservation, substitution, occupancy |
| STAGE_2_PART_3_DISPATCH_TRACKING_EXCEPTIONS.md | 0.3 | Assignment, dispatch authorisation, trip events, offline rules, tracking and consent, exceptions |
| STAGE_2_PART_4_POD_DISPUTES.md | 0.3 | Proof of delivery, review, disputes, post-dispatch cancellation, adjustment records. Five open design issues (DI-401 to DI-405) in section 13 |
| REGIONAL_GEOGRAPHY.md | 0.3 | D-003 split (target geography, initial countries, lanes, eligibility, launch dependencies), transit-country checks, named time zones, D-014 business base |
| STAGE_3_ARCHITECTURE.md | 0.5 | Recommended architecture, modules, data relationships, permission enforcement, offline synchronisation, environments, foundation backlog |

Not yet written: invoice, payment and reconciliation (waits for D-001 and D-002); design system (Stage 4).

Foundation-only setup (repository structure, configuration, database connectivity, CI) waits for no decision.
Booking implementation and operational policies stay gated on the approved rules listed in each part.
