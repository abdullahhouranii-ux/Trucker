# Trucker: price breakdown, views by role, fee payer and freight terms, slice 25 record

Date: 17 November 2026. Branch `feat/price-breakdown`, stacked on PR #28. Second slice of phase three (ADR-001 section 7), after Abdullah's "approved continue" of 17 November 2026 (15:29), read as accepting slice 24 as built and going on. No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3): R-9, R-18 and R-26 (confirmed), G-5 and G-6 (design), D-5, D-9 and D-11 (defaults). Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Freight terms on a quotation (R-26) | The carrier states which freight payment methods it accepts: cash on delivery, bank transfer, or its own card gateway; for a transfer, the days after proof of delivery within which it is due, at most the freight due days of the financial settings in force. A revision may change them; a reconfirmation keeps them |
| Freight fixed on the booking (R-26) | When it accepts, the customer chooses one of the offered methods (taken without asking when only one is offered). The booking fixes the method and the due rule: at delivery for cash, or the stated days after proof of delivery |
| Fee payer (D-5) | Trucker's fee is paid by the shipment's fee payer: the contracting customer, or the organiser where it agreed to pay (slice 22). The fee payer setting is removed from the security settings |
| One price record per booking (G-5) | Shipping price, commission option and its inputs, commission, carrier net, Trucker's fee and its basis, the fee payer, the customer's total, the freight payer, method and due rule, currency, minor units, rounding, and the financial settings version. Written once; the database refuses a record whose parts do not add up exactly, and any later change |
| Views by role (G-6, D-11, R-9) | The database chooses the figures for the one asking. Customer: shipping price, fee (with who pays it), its total; never the commission or the carrier's net. Carrier: shipping price, commission, its net; not the fee nor the customer's total. Organiser: shipping price, commission, net, and the fee when it pays it, shown on its own shipment's page. Staff: everything |
| Web | The quotation form has a freight section; each quotation shows its freight terms; the acceptance asks which method when more than one is offered; the booking shows each role its own figures and how and when the freight is paid; the organiser's shipment shows the booked price. English, Arabic and Urdu |

## Behaviour changed from earlier slices

- The carrier no longer sees Trucker's fee or the customer's total on a booking, and the customer no longer sees the carrier's net (D-11). Two earlier checks asserted that both parties saw the same figures; they now assert each role's figures.
- A carrier can no longer be the fee payer. Under the earlier model a setting could make it so; under D-5 the fee payer is a shipment role. Older bookings keep the payer they were made with.

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| D-5 | The fee payer is the shipment's fee payer; with none named, the contracting customer |
| D-9 | Cash on delivery: due at delivery. Transfer: within the days the quotation states, at most the freight due days in force (15 by default) |
| D-11 | Who sees what, as in the table above |
| P-1 | The customer chooses the freight method at acceptance, among those the carrier offered, also when the sender or receiver pays the freight |
| P-2 | The carrier's own card gateway is refused as a method until an activation exists; none is built |
| P-3 | A quotation that states no freight terms offers bank transfer within the days in force. Quotations made before this slice are taken the same way |

## How it is built

Migration `0023_price_breakdown.sql`, forward-only. `quotation_version` gets the freight methods and days, with a constraint that they hang together; `quotation_freight` judges them; submission, revision, reconfirmation and the version view carry them. `booking` gets the freight method, due rule and days. `accept_quotation` takes the chosen method (a new parameter; the API's acceptance body takes an optional `freightMethod`). `acceptance_terms` takes the fee payer from the shipment's roles. Table `booking_price`, closed to the API's role, written by a trigger after the booking's commission and roles, never changed; bookings made before this migration get one too, marked as such. `booking_price_values` and `booking_money` choose the figures by role inside the database; every booking view, list and acceptance reply uses them.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 351 pass, 0 fail (4 new tests in `price/price.test.ts`); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including 3 new checks: each role's figures on the booking pages, the organiser's booked price, and a freight choice refused when missing and fixed when made |
| Console browser checks | All passed |
| Stability | The new tests ran 3 times in a row without failure |
| Deliberate faults | Fourteen faults put into the migration one at a time. Thirteen were caught at once. One was missed: a reconfirmation dropping the freight terms. A test for it was added and now catches it |

Found while testing and fixed in this slice: a revision that changed only the freight terms was refused as "nothing changed".

## Not done, and limits

- The concrete freight due date is not computed: it needs proof of delivery (phase five). The booking holds the rule and the days.
- Paying the fee, verifying a transfer and refunds are phase four.
- The backfill of older bookings ran only on databases that had none; no test exercised it with existing bookings. Its figures are checked by the same constraints as new records, so a mismatch would stop the migration rather than pass silently.
- The organiser's booked price is shown on its shipment page only, not in a list.
- Wording and layout points are in the final-audit backlog.
- No physical-phone, screen-reader or native Arabic and Urdu review.

## Decisions needed (none blocks the next slice)

- **P-1.** Who chooses the freight method when the sender or receiver pays the freight? Built: the contracting customer, at acceptance. I recommend keeping it: the customer is the one who agrees the transport.
- **P-2.** Card payment through the carrier's own gateway needs an activation process (what is checked, by whom). It is refused until you decide how a gateway is activated.
- The production values of D-5, D-9 and D-11 remain yours to approve.
