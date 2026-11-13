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
Commercial model (D-001), payment approach (D-002) and launch geography (D-003) are undecided.

## Current milestone

M0: requirements baseline and development environment. No API, portal or mobile code exists yet.

## Next executable slice

Set up a NestJS API, PostgreSQL migration/connection, Next.js web portal, environment
template, local dependency services, health/readiness checks and relevant CI.
Then implement real sign-in, organisation membership and shipper create/list shipment.
Use compatible stable versions verified at implementation time and commit lockfiles.
Do not return mock successes or confuse the reference HTML with the hosted product.

## Open decisions

- Five-role web plus driver mobile first, versus every native role at initial launch.
- Hosting, identity, payment, storage, maps and notification suppliers.
- Approved commercial, cancellation, settlement and location policies.
- Optional ERP/accounting integration; Odoo is not a mandatory core dependency.

## Environment

Repository cloned and inspected on 13 November 2026 at commit d8107af.
tools/dev and docs/api are planned locations and do not exist yet.
No dependencies installed; no application tests run.
