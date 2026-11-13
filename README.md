# Trucker

New freight-platform project owned by Abdullah.

Remote: https://github.com/abdullahhouranii-ux/Trucker

## Current status

Foundation only (13 November 2026). Implemented and tested: an npm workspace with `apps/api`
(validated configuration, `/health/live`, `/health/ready`, one standard error body, request
identifiers), a forward-only SQL migration runner, and local helper commands. Evidence and
limits: docs/delivery/FOUNDATION_SLICE_1.md and FOUNDATION_SLICE_2.md.

Local setup: `npm ci`, `npm run dev:env`, `npm run dev:db:up` (Docker) or your own
PostgreSQL 16, `npm run dev:doctor`, `npm run dev:migrate`, `npm run dev:verify`,
`npm run dev:api`. Windows: docs/delivery/WINDOWS_SETUP.md.

No business feature exists: no sign-in, organisations, shipments, bookings, portals or mobile
application. Those are specified provisionally in docs/specs and gated on recorded decisions.

## Product reference

The intended product context is the TruckLink Plan B freight platform: shipper,
carrier, independent vehicle owner, driver and operations roles; EN/AR/UR.
The target platform has seven surfaces: public website, shipper portal, carrier portal,
vehicle-owner portal, driver application, operations console and partner integration.
Surfaces are not roles; the public website and partner integration add no user role.
The existing TruckLink implementation has not been copied.

Abdullah selected a fresh Plan B implementation on 13 November 2026.
Build Trucker independently; use TruckLink only as a requirements and design reference.
Launch surfaces and any optional Odoo integration still require decisions.

## Reference files

docs/reference contains the repaired offline prototype, original architecture,
draft implementation plan and Claude Code handoff prompt from the preceding discussion.
These retain their original TruckLink names for provenance. They are references,
not a claim that their proposed architecture, estimates or sequencing are approved.

Never copy real credentials, private customer data, local environments or user-specific IDE files.

## Specifications

docs/specs is the single authoritative set of specifications; see docs/specs/README.md for the
index and versions. Copies in the Claude project are synchronised references. All documents are
provisional. Only the foundation slice is implemented and tested
(docs/delivery/FOUNDATION_SLICE_1.md); no business feature is implemented.

Commercial model (D-001), payment approach (D-002) and launch geography (D-003) are undecided.

## Next step

Follow docs/delivery/STATUS.md and BACKLOG.md. Foundation-only setup (repository structure,
configuration, database connectivity, CI) can proceed and waits for no decision.
Booking implementation and operational policies wait for their approved rules (docs/specs).
No TruckLink source-code migration is planned.
