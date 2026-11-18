# Trucker delivery status

Date: 17 November 2026. Replaces the status of 13 November 2026, which described the foundation stage.

## Approved direction

Trucker is a separate project from TruckLink, in `abdullahhouranii-ux/Trucker`; nothing is copied from TruckLink's implementation. The commercial model is recorded in `docs/specs/ADR_001_COMMERCIAL_MODEL.md`: Trucker acts as an agent and earns a separate fee, paid and verified before a booking is confirmed; an organiser's commission is included in the shipping price and paid by the carrier to the organiser.

## Built

Each slice has a scope and a record with its evidence in this folder.

| Slices | Content | Where |
|---|---|---|
| 1 to 10 | Foundation, web foundation, registration and sign-in, organisations, identity hardening, shipment drafts, staff identity, organisation verification, shipment publication | Merged into `staging` (not `main`) |
| 11 | Carrier onboarding and discovery | PR #15 |
| 12 | Quotations | PR #16 |
| SEC-01 | Security fix (release blocker until merged and `staging` is green) | PR #17 |
| — | Release 1 plan and readiness documents | PR #18 |
| 13 | Fleet and drivers | PR #19 |
| 14 | Acceptance and booking | PR #20 |
| 15 | Assignment, reservation and confirmation | PR #21 |
| 16 | Cancellation before dispatch | PR #22 |
| — | ADR-001 and the phase two scope (documents) | PR #23 |
| 21 | Individual accounts and truck owners | PR #24 |
| 22 | Shipment roles and authority | PR #25 |
| 23 | Organiser commission: percentage and fixed amount | PR #26 |
| 23b | Commission contracts accepted in advance | PR #27 |
| 24 | Financial settings: versions, second-administrator approval, effective time | PR #28 |
| 25 | Price breakdown, views by role, fee payer from roles, freight terms on each booking | PR #29 |
| 26 | Trucker's fee before confirmation: bank transfer verified by two administrators, lapse at the deadline, refund records | PR #30 |
| 27 | Online payment of the fee through a provider-neutral interface (development stand-in only), receipts; corrected after the independent review of 17 November 2026 (R2 to R5) | PR #31 |
| 28 | Refunds of the fee (requested, approved, submitted, completed or failed; partial; never more than the payment) and reconciliation, by independent staff; no real provider, no money moves | PR #32 |
| 17a | Dispatch (one step, refused with the first failing precondition, idempotent) and the trip's milestones by the driver or on the driver's behalf, the arrival estimate, and what each party sees; exceptions (17b) not built | PR #33 |
| 17b | Exceptions reported by the driver, carrier or shipper; the operations privilege, queue and cases; overrun and missing-arrival cases; dispatch blocks, trip holds, operations' milestones and withdrawing a mistaken one | PR #34 (planned number) |

Pull requests #15 to #32 are stacked, open and green in CI; slice 17a's pull request is open. None is merged; each needs a dependency review and Abdullah's explicit authorisation.

## Next

1. Phase five (dispatch, proof of delivery, settlement, closure), each as its own unmerged pull request, on development defaults, under the instruction of 17 November 2026 (11:46).
2. Slice 18 (delivery outcome, proof of delivery, release of resources). Slice 17 is built: `DISPATCH_SLICE_17A.md`, `EXCEPTIONS_SLICE_17B.md`.

## Open decisions

- ADR-001: defaults D-1 to D-12 and open decisions O-1 to O-7, including merging #15 to #22 (O-6).
- Dispatch: DD-1 to DD-10 (`DISPATCH_SLICE_17_SCOPE.md`).
- Launch country and lanes; suppliers (hosting, sign-in messages, file storage, payment provider).
- Adviser questions: ADR-001 section 8 and the external blockers in `RELEASE_1_GAP_TO_LAUNCH.md`.

## Not claimed

No production deployment. No real participant data. All commercial values are development defaults. No physical-phone, screen-reader or native Arabic and Urdu review has been done; those are in `FINAL_AUDIT_BACKLOG.md`.
