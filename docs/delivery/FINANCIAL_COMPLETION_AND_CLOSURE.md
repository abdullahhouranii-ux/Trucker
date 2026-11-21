# Slices 19 and 20 — financial completion and operational closure

Local implementation on the Trucker development branch. Migration 0036 records transfers made outside Trucker. Migration 0037 adds the closure queue and one automatic closure record per eligible booking. The existing pre-confirmation fee, refund and reconciliation workflows remain authoritative for Trucker's fee.

## Financial recording

- The expected freight and organiser commission come from the immutable booking price and counterparties. The paying organisation reports all or part of an external payment with a transfer reference and a reference to evidence held privately. The receiving organisation confirms or rejects the report. When the terms name the sender or receiver as freight payer, the contracting customer can report payment on their behalf.
- One staff administrator records the evidence review and a different administrator independently records the amount and currency on the statement or other evidence. The system derives match or discrepancy. A correction adds another review and decision to the immutable history. A statement line can be rechecked for its original payment and cannot match another payment.
- A booking is financially eligible when its booked freight and commission are matched, fee and refund records reconcile, and its cause-specific settlement holds have been released. Staff can record the facts of a payment while a hold is active. The hold continues to block financial eligibility and operational closure.
- An organisation can list its own payment obligations, including an organiser's commission, without access to the other obligations. Staff administrators can open the financial record by booking identifier. Operations receives blocker names and ownership.

## Closure

- The existing trip watcher checks accepted POD for the latest delivery outcome, financial eligibility, released reservations and occupancy, and cargo custody. Cancelled bookings remain outside this dispatched-booking closure flow.
- Under the trip lock, the checker records closure once. A later discrepancy or a new hold marks the booking for review and returns it to the operations queue while preserving the original closure audit record. Users can assign follow-up from the operations page. Closure does not release cargo, holds, or physical resources.
- The local flow records external payments. Original payment-evidence retention and the authority for exceptional closure still need approval before production.

## Invoice policy confirmed by Abdullah on 20 November 2026

- Trucker issues its platform service fee invoice immediately after payment is confirmed and sends it to the booker's phone or WhatsApp. The booker's contact is the delivery destination. The accountant still needs to confirm the legal invoice recipient when it differs from the booker or payer, and the exact details of the issuing entity.
- Add VAT to the platform fee at the [Oman standard rate of 5%](https://tms.taxoman.gov.om/portal/ar/tax-rate) where the standard rate applies and the issuer is registered for VAT. Accounting must still confirm the issuing entity and its registration, treatment of supplies outside the standard rate, invoice type and numbering, and Fawtara applicability.
- Platform fees are non-refundable by default. Exceptions require a defined approval rule and accounting treatment for the resulting invoice correction. The decision does not determine the circumstances that qualify for an exception.
- The carrier or independent carrier issues the freight invoice. The issuer of the organiser commission document still needs confirmation.
- Migration 0038 prepares one internal invoice draft in the same transaction that confirms a settled platform fee, with the paid amount, currency, payer organisation and original booker recorded. The payer's administrators and staff administrators can view it. Staff can see a 5% OMR illustration, while the actual paid amount stays separate. Bookings paid before 0038 are excluded from draft creation. Fee pricing, receipts, and existing refund controls continue to use their original rules. Live tax issuance and SMS or WhatsApp delivery require the verified issuer, recipient rules, approved refund exceptions, and a configured channel.

## Local verification

API, web and console production builds passed. On isolated PostgreSQL, 29 non-browser checks passed across the new financial and closure flow, disputes, POD, cargo and refunds. A focused Chrome journey passed across the shipper, carrier, operations and two finance administrators. It exercised reporting and confirmation, independent matching and assigning closure follow-up. The API integration also checked hold eligibility, two concurrent closure checks, later discrepancies, same-payment statement rechecks, tenant isolation and the preserved closure record. CI, full fresh installation and deployment were outside this run.
