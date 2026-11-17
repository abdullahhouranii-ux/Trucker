# Trucker: individual accounts and truck owners, slice 21 record

Date: 17 November 2026. Branch `feat/individual-accounts`, stacked on PR #23. Scope: `ACCOUNTS_PHASE_2_SCOPE.md`, approved by Abdullah on 17 November 2026 ("Approved 21 proceed"), with P2-1 and P2-2 taken as recommended. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md`. Nothing is merged or deployed. Test accounts and fictional evidence only.

## What changed

| Area | Change |
|---|---|
| Personal account | A person creates one personal account: an organisation record of kind `individual` with exactly one member. The database keeps it to that member and never lets the kind change |
| Capabilities | `organise` (coordinator on a personal account, broker on a company) and `carry_as_owner_operator` (personal account only), applied for and decided by staff through the existing verification flow. Each kind of account can apply only for what it may hold; a trigger refuses any other capability whatever wrote it |
| Organiser | A verified organiser creates and publishes its own shipments, as a shipper does. Acting for others is slice 22 |
| Truck owner | Counts as a carrier everywhere a company does: discovery, quotation, fleet, eligibility, assignment, acknowledgement, cancellation. No check is relaxed |
| P2-1 | A truck-owner account holds one active truck and one active trailer. Nobody can be invited as its driver. The owner becomes its driver by a recorded act; the rule of one active affiliation per driver holds against company affiliations in both directions |
| P2-2 | One personal account may hold both capabilities. It cannot quote on its own shipment: no account discovers its own shipments (CB-2), unchanged |
| Shipper's comparison | Each quotation shows whether the carrier is a transport company or a truck owner |
| Staff console | The queue and the application page show the kind of account; the withdrawal form offers the new capabilities |
| Web | "Create a personal account" from the new-organisation page; the carrier page applies for the truck-owner capability on a personal account; the fleet page of a truck owner shows the driver card in place of the invitation form. English, Arabic and Urdu |

## How it is built

Migration `0018_individual_accounts.sql`, forward-only. New: `organisation.kind`, three guard triggers, `capability_allowed`, `is_carrier`, `create_personal_account`, `become_own_driver`. Replaced with their latest definitions and the named change: the eight functions that asked "is this a company carrier" (now `is_carrier`), `submit_verification`, `staff_verification_revoke`, `staff_verification_view`, `staff_verification_queue`, `register_vehicle`, `invite_driver`, `carrier_service`, `organisation_publishable`, `organisation_may_publish`. The replaced bodies were taken from the database after migration 0017, so they are exactly what was in force.

Existing organisations become kind `company`; no existing record, quotation or booking changes.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 327 pass, 0 fail (4 new tests in `individual.test.ts`); web 24; console 9 |
| API, web and console builds | Passed |
| Web browser checks | All passed, including 6 new checks of the personal account, the truck owner's application, the one-truck limit, the refusal while still driving for a company, and the driver card, in English, Arabic and Urdu. The first run failed on one accessibility check (the link between the two forms was too small a touch target); it is now a button and the full rerun passed |
| Console browser checks | All passed (243) |
| Deliberate faults | Six faults put into the migration one at a time were each caught by the new API tests: the member guard removed; the kind rule removed from submission; the one-truck limit removed; invitation allowed; a second personal account allowed; a company affiliation ignored when becoming one's own driver |

The four API tests cover IA-1 to IA-7 and P2-1, P2-2: one account per person under a race; the member and kind guards; capability by kind; the full journey of a truck owner to a confirmed and acknowledged booking and its cancellation; the one-truck limit under a race; the single-affiliation rule in both directions and under a race; an organiser publishing; isolation.

## Not done, and limits

- Shipment roles and authority (slice 22) and commission agreements (slice 23) are not in this slice.
- A company can add `organise` only after it is verified for another capability; an unverified company applying first as a broker waits for slice 22's forms.
- The personal account form reuses the labels "Legal name" and "Registration number", with an explanation above the form; the carrier page still says "organisation". Both are in the final-audit backlog.
- Real identity evidence, its retention, and any consumer or licensing obligations are adviser questions (ADR-001 section 8). Production cannot start on the fictional registers.
- No physical-phone, screen-reader or native Arabic and Urdu review.
