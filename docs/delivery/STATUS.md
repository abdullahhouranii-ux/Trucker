# Trucker delivery status

Date: 13 November 2026

## Approved direction

Fresh Plan B project in abdullahhouranii-ux/Trucker. Do not copy TruckLink's implementation.
Product name: Trucker. Preserve historical reference files as references.

## Completed

- Fresh-build decision recorded and initial backlog established.
- Original architecture, repaired prototype and planning references added under docs/reference.
- First commit pushed to GitHub (documents only).
- Files moved from the nested Trucker/ folder to the repository root.
- Provisional Stage 1 baseline and Stage 2 Parts 1-4 and the Stage 3 architecture evaluation saved under docs/specs, the authoritative set (documents only; no tests run).

## Scope note

Seven surfaces: public website, shipper portal, carrier portal, vehicle-owner portal, driver
application, operations console, partner integration. Five roles; surfaces are not roles.
Commercial model (D-001) and payment approach (D-002) are undecided. Target geography: Middle East,
prioritising the six GCC countries. Initial countries, lanes and eligibility (D-003b to D-003d) are
undecided. Preferred business base (D-014): Dubai free-zone company; free zone undecided; nothing
registered. See docs/specs/REGIONAL_GEOGRAPHY.md.

## Current milestone

M0: foundation. Foundation slice 1 and its review fixes are merged into staging (not main).
Foundation slice 2 is also merged into staging (pull request 3): standard API error body, request
identifiers, local helper commands, and CI jobs that exercise the Docker compose database and
the native Windows setup. Evidence: docs/delivery/FOUNDATION_SLICE_1.md and
FOUNDATION_SLICE_2.md. Not verified: Docker Desktop on Windows, a Windows desktop machine,
macOS. Only apps/api exists. No business module, portal or mobile code exists.

## Next executable slice

Decision-independent platform primitives F-07 to F-11 (docs/specs/STAGE_3_ARCHITECTURE.md,
section 12), each on Abdullah's instruction. The first functional journey (sign-in,
organisations, shipment create and list) waits for decisions on enabled countries and lanes
(D-003b to D-003d) and the sign-in method (Q-101), and for Abdullah's approval of its scope. Business modules stay gated on their recorded decisions.
Do not return mock successes or confuse the reference HTML with the hosted product.

## Open decisions

- Five-role web plus driver mobile first, versus every native role at initial launch.
- Hosting, identity, payment, storage, maps and notification suppliers.
- Approved commercial, cancellation, settlement and location policies.
- Optional ERP/accounting integration; Odoo is not a mandatory core dependency.

## Environment

Repository cloned and inspected on 13 November 2026 at commit d8107af.
tools/dev holds the local database definition; docs/api does not exist yet.
