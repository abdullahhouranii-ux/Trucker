# Internal draft of the platform fee invoice

Decided by Abdullah on 22 November 2026: build the internal invoice draft only. Taken from Codex's unreviewed local work (his migration 0038) and placed on its own branch, `feat/invoice-draft`, stacked on `feat/mobile`. Migration 0041.

## Behaviour

- When Trucker's platform fee is settled (online or by verified transfer), one internal draft is prepared in the same transaction: the paid amount, currency, paying organisation, the original booker and the payment time. Two payments for one fee still make one draft. Fees paid before 0041 get none.
- The payer's administrators see the draft on the booking page; staff administrators see it in the console's booking financial records. Anyone else is answered as for a missing record. Staff reads are audited.
- Its status is "pending issuer and tax". **Nothing is issued, numbered as a tax invoice, or sent, and no tax is calculated.** Codex's staff-only 5% VAT example was left out under the decision above.
- The draft is never changed or removed.

## What a real tax invoice still needs

The recommendation accepted on 22 November is that Trucker does not calculate tax itself: it passes the fee to an accounting system that issues the tax invoice and keeps up with VAT and Oman's e-invoicing (Fawtara). Before any real invoice, the accountant confirms the issuing entity, its VAT registration and numbering, and when e-invoicing applies to it.

## Verification (22 November 2026)

| Check | Result |
| --- | --- |
| `npm run verify` | See the pull request |
| Deliberate faults in 0041 | Four, all caught: another party reading the payer's draft, no draft on payment, a tax figure added to the draft, a staff member without `staff_admin` reading it |
