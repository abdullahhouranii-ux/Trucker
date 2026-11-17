# Trucker: organiser commission, slice 23 record (percentage and fixed amount)

Date: 17 November 2026. Branch `feat/commission`, stacked on PR #25. Built under Abdullah's instruction of 17 November 2026 (11:46), "proceed all slices", read as: build the remaining slices in order, using the recommendations as development defaults. No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3), requirements R-5 to R-9, not reopened. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Stating the commission | The organiser of a shipment arranged for a customer states its commission on the draft: a percentage of the shipping price, or a fixed amount in a named currency. Not possible on a shipment of its own. Fixed once the shipment has been published |
| What the carrier quotes | The carrier quotes the shipping price the customer pays. The commission is included in it. The carrier's net earnings are the price less the commission |
| Carrier's acceptance | No quotation exists on such a shipment unless the carrier accepted exactly the commission and the net that follow from its price. Without it the quotation is refused and the two figures are named. A new price needs a new acceptance |
| Who sees what | The carrier sees price, commission and net on its own quotations and bookings. The organiser sees them on the shipments it arranged. The customer sees the shipping price and no commission, including when the customer is itself a carrier |
| Booking | The booking keeps the commission as accepted, written once. Update, delete and truncate are refused |
| Trucker's fee | Unchanged: reckoned on the shipping price, as before |
| Web | A commission form on the shipment page for the organiser; on the carrier's page, the commission stated before pricing, an acceptance step with the exact figures, and commission and net beside its own quotation. English, Arabic and Urdu |

## Development defaults used (not approved for production)

| ADR item | Value used |
|---|---|
| D-1 | A percentage is of the customer shipping price |
| D-2 | Rounded half-up to the currency's minor unit; the net is the price less the commission, never rounded on its own |
| D-3 | A percentage is from 0.01% to 25%; a fixed amount must be in the quotation's currency and leave the carrier more than zero |
| O-1 | The carrier quotes the shipping price |

## How it is built

Migration `0020_commission.sql`, forward-only. Tables `shipment_commission`, `quotation_commission` and `booking_commission`, closed to the API's database role. No quotation function was changed: a trigger on each new quotation version computes the figures and refuses the version unless the carrier's acceptance, passed for that transaction only, matches them exactly. A version that only reconfirms the same price keeps the earlier acceptance. A trigger copies the commission to the booking. New commands: `set_shipment_commission`, `shipment_commission_terms`, `commission_overview`. API routes: `POST` and `GET /organisations/:org/shipments/:id/commission`, `GET /organisations/:org/commissions`; quotation bodies take an optional `commissionAccepted`.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 339 pass, 0 fail (5 new tests in `commission.test.ts`); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed on the first run, including 5 new commission checks |
| Console browser checks | All passed |
| Deliberate faults | Eleven faults put into the migration one at a time. Ten were caught at once. One was missed: "the customer can read the terms when it is also a carrier". A test for that case (CM-5) was added and now catches it |

## Found during this slice

The slice 21 deadlock (becoming one's own driver while accepting a company's invitation) came back in a full test run. The earlier fix was incomplete: the acceptance took the person's turn only after it had locked the person's row. The server log of the failed run shows the cycle. Both commands now take the turn before any row. A new test shows the lock order without depending on timing; it fails on the earlier version and passes now. Fixed on PR #24 and merged into #25 and this branch. My earlier statement that the first fix was verified by 25 passing runs was wrong as a proof: the fault was rare, not gone.

## Not done, and limits

- The third option of the plan, a commission contract accepted in advance, is not built. It is the next slice (23b).
- The 25% limit is fixed in the migration, not a staff setting. It moves to the financial settings of phase three.
- When the commission is earned and paid (D-10) belongs to settlement. Nothing is paid or owed by this slice.
- A fixed commission in a currency other than the quotation's is refused. This is tested at the database function only, because the test data has one currency.
- The organiser has no web page listing its commissions yet; they are available from the API.
- On the web, after the refusal the form is refilled by the page's draft keeper. Without JavaScript the carrier retypes it.
- The acceptance hint sits beside the tick box label rather than under it at 390 px: in the final-audit backlog with the wording of the new messages.
- No physical-phone, screen-reader or native Arabic and Urdu review.

## Decisions needed

None blocks the next slice. For production: D-1, D-2, D-3 and O-1 above.
