# Trucker: Trucker's fee before confirmation, slice 26 record

Date: 17 November 2026. Branch `feat/fee-payment`, stacked on PR #29. First slice of phase four (ADR-001 section 7), after Abdullah's "go a head" of 17 November 2026 (16:56). No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3): R-10 to R-15 (confirmed), G-8, G-9 and G-11 (design), D-6 to D-8 (defaults). Online payment (G-10) is slice 27; processing refunds is slice 28. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Fee obligation (R-10, D-6) | Every new booking records Trucker's fee due: the amount from its price record, the payer (customer, or the organiser where it pays), a reference to quote (`TF-` and ten hexadecimal digits), and a deadline: the hours of the financial settings in force after acceptance (12 by default), never after the assignment deadline. A fee of nothing is recorded as not required. Bookings made before this slice keep the old rule |
| Bank transfer, two people (G-9, R-11, R-12) | One administrator records a transfer seen on Trucker's bank statement: reference, amount, currency, value date and the statement line's reference. A different administrator approves or rejects it; a rejection needs a reason. A payer's slip or message is never proof: nothing a participant does marks a fee paid |
| What is recorded (R-13) | Against a fee that is due, only an exact amount in the fee's currency. A statement line is matched once (a rejected record frees it). A request retried with the same key records once; the same key for something else is refused |
| Confirmation needs both (R-14, G-8) | A booking is confirmed only when the fee is verified and every required resource is assigned, eligible and reserved. Whichever comes second confirms it, in the same transaction, under the locks the assignment and cancellation commands take. A booking with every resource but no fee shows "Awaiting Trucker's fee" |
| Lapse at the deadline (D-7, R-15) | A fee not verified by its deadline lapses the booking as a recorded cancellation by Trucker (`fee_not_paid`): reservations and assignments end, nothing is charged, and the shipment can be published again. After the deadline nothing more is reserved for the booking. A job in the API records lapses every minute, one booking per call; every command that could act on such a booking lapses it first |
| Transfer in hand at the deadline | A transfer recorded by the deadline holds the booking until the second administrator decides. Approved, it settles the fee; rejected, the booking lapses at once. A transfer recorded after the deadline never holds or settles it |
| Money to return (G-11, D-8) | Recorded as refunds, with the reason: money verified after the booking lapsed or was cancelled; money paid twice; and the full fee of a booking cancelled after payment. Processing them is slice 28 |
| What each party sees | The payer: amount, reference, deadline, whether a transfer is being verified, and its refunds. The other party: only whether the fee is settled and by when. Staff: everything. An organiser who pays sees it on its own shipment's page |
| Web | The booking shows Trucker's fee to each role as above, and says how to pay. The status "Awaiting Trucker's fee", the fee blocker in "Where this booking stands", a lapse shown as cancelled by Trucker at the fee deadline. English, Arabic and Urdu |
| Console | A "Fee payments" page: record a transfer, approve or reject one recorded by someone else, fees due (soonest first, overdue marked), money to return, decisions made. The financial settings gain the time to pay the fee |

## Behaviour changed from earlier slices

- Full assignment alone no longer confirms a booking with a fee due. Earlier tests that confirmed by assignment now have the fee verified first by two administrators, through the same staff routes.
- A cancellation can now be recorded by Trucker (party `platform`, reason `fee_not_paid`). Only a lapse uses it.
- The financial settings have one more value, the time to pay the fee; a draft without it is refused.

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| D-6 | 12 hours after acceptance, never after the assignment deadline. In this environment the assignment deadline is also 12 hours after acceptance, so the two fall together |
| D-7 | As above |
| D-8 | Every refund case is recorded as a full refund. Second-administrator approval and the five-business-day limit come with processing in slice 28 |
| FP-1 | A transfer recorded by the deadline holds the booking until the second administrator decides |
| FP-2 | Only an exact match is recorded against a fee that is due. A short or over-payment is not recorded here; it waits for reconciliation (slice 28) |
| FP-3 | Recording and approving are done by staff administrators, as for the financial settings (F-1 still open) |
| FP-4 | No bank account details are shown: none were given. The payer is told they are not set up in this environment yet |

## How it is built

Migration `0024_fee_payment.sql`, forward-only. `financial_setting_version` gets `fee_payment_hours`. Tables `booking_fee` (one per booking, written by a trigger after the price record; moves only from due to paid, lapsed or closed), `fee_payment` (a recorded transfer; decided once; the database refuses an approval by the person who recorded it) and `fee_refund` (never changed in this slice), all closed to the API's role. `booking_confirmation` records whether the assignment or the fee verification completed it, and by whom. `set_booking_assignment` confirms only when the fee is settled and refuses an overdue booking; `cancel_booking` lapses first when due and closes or refunds the fee. Every command that can end or confirm a booking takes the same locks in the same order (`booking_lock_set`), then reads the clock, then decides. New callable functions: `staff_fee_payments`, `staff_fee_record`, `staff_fee_decide`, `lapse_overdue_fee`. API routes: `GET /staff/fee-payments`, `POST /staff/fee-payments` (Idempotency-Key), `POST /staff/fee-payments/:id/decision`. The lapse job runs in the API every minute (`FEE_LAPSE_INTERVAL_MS`; 0 turns it off; under test the tests run it). The consistency check reports any confirmation without the fee.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 358 pass, 0 fail (7 new tests in `fee/fee.test.ts`); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including 3 new: the customer is shown the amount, the reference and the deadline and the carrier is not shown the reference; a fee settled by two administrators is shown paid |
| Console browser checks | All passed, including the fee payments page (empty lists, an unknown reference refused and named in the summary, nothing recorded) and the time to pay in the financial settings |
| Stability | The new tests and the assignment tests ran 3 times in a row without failure |
| Deliberate faults | Eight faults put into the migration one at a time. Six were caught at once. Two were missed: a lapse that ignored a transfer in hand, and a transfer recorded after the deadline settling a fee held by another. Tests for both were added and now catch them |

Found while testing and fixed in this slice: a confirmation by fee verification wrote the confirmation event for both parties, which the one-confirmation rule of slice 15 refuses (now the shipper's history only, as before); a refund recorded by a cancellation carried no actor.

## Not done, and limits

- The console's approve and reject buttons were not exercised in a browser: the console's test database has no booking. The two-person flow is exercised through the API (FP-2 to FP-7) and, for the web, through the staff routes.
- Online payment (G-10) is slice 27; refund approval and payment (D-8) and reconciliation, including unmatched money, are slice 28.
- Trucker's bank account details are not configured anywhere.
- A lapse is recorded within a minute of the deadline by the job, or at once by any command on that booking; until then the booking shows the fee as not paid by the deadline.
- Wording and layout points are in the final-audit backlog.
- No physical-phone, screen-reader or native Arabic and Urdu review.

## Decisions needed (none blocks the next slice)

- **FP-1.** What counts as paid in time for a transfer: recorded by staff by the deadline (built), or the bank's value date? I recommend keeping the recording time: the value date has no time of day and staff can only act on what the statement shows.
- **FP-2.** A transfer that does not match the fee exactly: refuse it here and return it through reconciliation (built), or accept it with the difference returned? I recommend refusing until reconciliation exists.
- **FP-4.** Trucker's bank account details: what they are, and that a change to them is approved by a second administrator like the financial settings. Needed before any real payer can pay.
- F-1 (a separate finance privilege) now also covers who records and approves transfers.
- The production values of D-6 to D-8 remain yours to approve.
