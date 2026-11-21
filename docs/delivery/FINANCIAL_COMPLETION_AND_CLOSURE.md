# Slices 19 and 20 — financial completion and operational closure

Implemented by Codex locally (unreviewed branch `codex/unified-experience-mobile`) and split into its own branch, `feat/financial-completion`, on 21 November 2026, stacked on `feat/disputes`. Migrations renumbered when split: 0036 became 0037 and 0037 became 0038. Migration 0037 records transfers made outside Trucker. Migration 0038 adds the closure queue and one automatic closure record per eligible booking. The existing pre-confirmation fee, refund and reconciliation workflows remain authoritative for Trucker's fee.

## Financial recording

- The expected freight and organiser commission come from the immutable booking price and counterparties. The paying organisation reports all or part of an external payment with a transfer reference and a reference to evidence held privately. The receiving organisation confirms or rejects the report. When the terms name the sender or receiver as freight payer, the contracting customer can report payment on their behalf.
- One staff administrator records the evidence review and a different administrator independently records the amount and currency on the statement or other evidence. The system derives match or discrepancy. A correction adds another review and decision to the immutable history. A statement line can be rechecked for its original payment and cannot match another payment.
- A booking is financially eligible when its booked freight and commission are matched, fee and refund records reconcile, and its cause-specific settlement holds have been released. Staff can record the facts of a payment while a hold is active. The hold continues to block financial eligibility and operational closure.
- An organisation can list its own payment obligations, including an organiser's commission, without access to the other obligations. Staff administrators can open the financial record by booking identifier. Operations receives blocker names and ownership.

## Closure

- The existing trip watcher checks accepted POD for the latest delivery outcome, financial eligibility, released reservations and occupancy, and cargo custody. Cancelled bookings remain outside this dispatched-booking closure flow.
- Under the trip lock, the checker records closure once. A later discrepancy or a new hold marks the booking for review and returns it to the operations queue while preserving the original closure audit record. Users can assign follow-up from the operations page. Closure does not release cargo, holds, or physical resources.
- The local flow records external payments. Original payment-evidence retention and the authority for exceptional closure still need approval before production.

## Not in this branch: the platform fee invoice draft

Codex's migration 0038 (an internal fee invoice draft with a staff-only 5% OMR VAT illustration) is held back on its own branch until Abdullah decides the points below. Codex's record of the invoice policy is kept here unchanged, for that decision.

### Invoice policy as recorded by Codex ("confirmed by Abdullah on 20 November 2026")

- Trucker issues its platform service fee invoice immediately after payment is confirmed and sends it to the booker's phone or WhatsApp. The booker's contact is the delivery destination. The accountant still needs to confirm the legal invoice recipient when it differs from the booker or payer, and the exact details of the issuing entity.
- Add VAT to the platform fee at the [Oman standard rate of 5%](https://tms.taxoman.gov.om/portal/ar/tax-rate) where the standard rate applies and the issuer is registered for VAT. Accounting must still confirm the issuing entity and its registration, treatment of supplies outside the standard rate, invoice type and numbering, and Fawtara applicability.
- Platform fees are non-refundable by default. Exceptions require a defined approval rule and accounting treatment for the resulting invoice correction. The decision does not determine the circumstances that qualify for an exception.
- The carrier or independent carrier issues the freight invoice. The issuer of the organiser commission document still needs confirmation.
- Migration 0038 prepares one internal invoice draft in the same transaction that confirms a settled platform fee, with the paid amount, currency, payer organisation and original booker recorded. The payer's administrators and staff administrators can view it. Staff can see a 5% OMR illustration, while the actual paid amount stays separate. Bookings paid before 0038 are excluded from draft creation. Fee pricing, receipts, and existing refund controls continue to use their original rules. Live tax issuance and SMS or WhatsApp delivery require the verified issuer, recipient rules, approved refund exceptions, and a configured channel.

## Verification on the split branch (21 November 2026)

Run on Node 24 with isolated PostgreSQL, on this branch alone.

| Check | Result |
| --- | --- |
| `npm run verify` | API 426 pass, 0 fail, 1 skipped (the browser journey, which passes when enabled); web 24/24; console 9/9 |
| Browser journey (`TRUCKER_DISPUTE_BROWSER=1`) | Passes: the dispute steps, then reporting and confirmation of freight, review and independent reconciliation by two administrators, and closure follow-up |
| Deliberate faults in 0037 and 0038 | Six, one at a time, all caught: the same administrator reviewing and reconciling, the reporter confirming their own payment, an active hold ignored, closure without an accepted POD, any amount reported as a match, closure with cargo still on the vehicle. Two were missed at first (the reporter confirming as an administrator of both organisations, and cargo in custody); checks were added for both |

## Decisions for Abdullah

1. **Invoice draft and VAT.** Confirm the invoice policy above, which Codex records as yours, before the invoice-draft branch goes forward: VAT at Oman's standard 5% on the platform fee where it applies, invoicing right after payment, delivery to the booker's phone or WhatsApp, and fees non-refundable by default. The issuing entity, its VAT registration, invoice numbering and Fawtara applicability need your accountant.
2. **Payment evidence.** Retention of original payment evidence and the authority for exceptional closure need approval before production.

## Codex's own verification (before the split)

API, web and console production builds passed. On isolated PostgreSQL, 29 non-browser checks passed across the new financial and closure flow, disputes, POD, cargo and refunds. A focused Chrome journey passed across the shipper, carrier, operations and two finance administrators. It exercised reporting and confirmation, independent matching and assigning closure follow-up. The API integration also checked hold eligibility, two concurrent closure checks, later discrepancies, same-payment statement rechecks, tenant isolation and the preserved closure record. CI, full fresh installation and deployment were outside this run.
