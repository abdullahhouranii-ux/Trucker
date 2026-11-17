# Trucker: online payment of Trucker's fee, and receipts, slice 27 record

Date: 17 November 2026. Branch `feat/online-payment`, stacked on PR #30. Second slice of phase four (ADR-001 section 7), continued under Abdullah's "continue" of 17 November 2026 (18:52). No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3): R-10 to R-13 (confirmed), G-10 (design). No payment provider is chosen or contacted: the only provider is a development stand-in that moves no money. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Provider-neutral interface (G-10) | The API talks to a payment provider through one interface: open a checkout, verify a signed notification, ask for a checkout's status. A real provider is a new implementation of it, chosen and contracted separately |
| Development stand-in | `PAYMENT_PROVIDER=test`: a stand-in that opens checkouts, shows a page with "Pay (stand-in)" and "Decline (stand-in)", and then sends a signed notification as a provider would. It asks for no card and moves no money. Refused in production and with a remote database; closed by default |
| Paying online (R-10, R-11) | The payer (the customer, or the organiser where it pays) chooses "Pay online" on its booking or shipment page and goes to the provider's page. The checkout carries the fee's amount and currency, and stays open 30 minutes, never past the fee's deadline |
| Against double charges (R-13) | Asking again, by retry, by a second click or at the same moment, resumes the checkout in progress; one checkout per booking at a time. Each notification is stored once by its identifier, and each provider transaction is applied once, whether it arrives by notification or by status check, and however often. This does not stop a provider from taking money twice (for example on an expired checkout): a second payment is recorded and returned. See `PAYMENT_PROVIDER_REQUIREMENTS.md` |
| What counts as proof (R-12, G-10) | Only a notification whose signature the provider's rules accept (HMAC over the exact bytes, at most 5 minutes old), or the provider's answer to a status check made by the server. Coming back from the provider's page proves nothing: the booking page says so until the notification is recorded |
| Amount and currency must match (G-10) | A signed notification with another amount or currency, or naming an unknown checkout, settles nothing; it is listed for staff on the console's fee payments page |
| Settlement and confirmation | A matching payment settles the fee and, when every resource is reserved, confirms the booking in the same transaction, recorded as confirmed by online payment |
| Deadline (R-15) | A checkout opened before the fee's deadline holds the booking until the checkout closes and 15 minutes more for the provider's word. Before lapsing anything, the fee job asks the provider about checkouts that closed with no word, so a payment taken in time and whose notification was lost still settles the fee if the provider answers within that time. If it does not, the booking lapses and the payment, when it is reported, is returned |
| Money to return (G-11) | Money taken for a booking that ended (lapsed or cancelled) or for a fee already paid becomes a refund record, as for transfers |
| Receipts (R-11) | Every payment that settles a fee, online or by verified transfer, gets a receipt numbered `TR-` and eight digits, shown to the payer only. It acknowledges payment; it is not a tax invoice. Transfers settled in slice 26 get theirs in the migration |
| Console | The fee payments page lists online payments to look into and online payments in progress; decided payments show when the provider's signed notice recorded them |

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| OP-1 | A checkout stays open 30 minutes, never past the fee's deadline (protected setting `checkout_minutes`, 5 to 120) |
| OP-2 | After a checkout closes, the booking waits 15 minutes for the provider's word before it can lapse (protected setting `payment_notice_grace_minutes`, 1 to 120) |
| OP-3 | A payment is in time when the provider took it by the fee's deadline (the provider's signed payment time) |
| OP-4 | A notification with a different amount or currency settles nothing and is held for staff; reconciliation is slice 28 |
| OP-5 | Receipt numbers are one sequence for all receipts; a rolled-back transaction can leave a gap. No tax-invoice rule is assumed |
| OP-6 | Signature tolerance 5 minutes; notifications up to 64 KB |

## How it is built

Migration `0025_online_payment.sql`, forward-only. Tables `fee_checkout` (one in progress per booking; moves only forward; a checkout that failed or expired here can still be reported paid, since the money was taken), `payment_notification` (once per provider and identifier, with what came of it) and `fee_receipt`, all closed to the API's role; `fee_payment` takes online payments (no recording staff member; the provider's word decides). New callable functions: `fee_checkout_open`, `fee_checkout_started`, `fee_checkout_refused`, `fee_checkouts_to_check`, `payment_report`. `payment_report` takes the booking's locks in the usual order, reads the clock, and checks again for the same notification before deciding. API: `src/payment` (interface, stand-in, signatures, service, routes): `GET /payments/options`, `POST /organisations/:id/fee-checkouts` (Idempotency-Key), `POST /payments/notifications/:provider` (read raw for its signature), and the stand-in's `GET`/`POST /payments/test/checkouts/:reference[/complete]`. The fee job asks the provider about closed checkouts before lapsing. Web: "Pay online" on the payer's booking and shipment pages, the stand-in's page, what the payer is told on coming back, and receipts. English, Arabic and Urdu.

The API verifies a notification's signature before the database is called; the database trusts the API's role to have done so, as it trusts it for everything else. The signing key of the stand-in is a published development value.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 365 pass, 0 fail (6 new tests in `payment/payment.test.ts`, 1 in `config/config.test.ts`); web 24; console 9. After the review: API 368 pass, 0 fail (PAY-7 to PAY-9 added) |
| Builds | Passed |
| Web browser checks | All passed, including 2 new: paying online through the stand-in's page, coming back to the fee shown paid with its receipt (and not shown to the carrier); the stand-in refusing to take a paid checkout twice |
| Console browser checks | All passed, including the two new sections of the fee payments page |
| Deliberate faults | Nine faults, seven in the migration and two in the signature check, put in one at a time. Eight were caught at once. One was missed: a notification that arrives while the same one is being applied, without the second look after the locks. The concurrency test now holds the lock until both requests wait, and catches it |

Found while testing and fixed: a check in the slice 23 tests looked for "1980" in a reply and failed when a random identifier contained those digits; it now looks for the amount "1980.00", which is what it meant. The stand-in page's back link was too small a target; it is now a button-sized link.

## Review of 17 November 2026

Abdullah asked for the claims about double charges and late notifications to be shown or withdrawn. Three tests were added (`payment/payment.test.ts`):

| Test | What it shows | Result before the fix |
|---|---|---|
| PAY-7 | Simultaneous requests open one provider checkout; a retry after the provider's answer was lost reaches the same provider checkout; only a refusal lets a new one be opened | Failed: a lost answer marked the checkout failed, and the retry opened a second provider checkout. Fixed: only a refusal closes it |
| PAY-8 | Money taken on a checkout Trucker had replaced is recorded; the second payment for the fee is returned | Passed |
| PAY-9 | With the provider unreachable, nothing settles; after the wait the booking lapses and other bookings still lapse; the late notification is returned; a captured notice replayed after the signature window is refused | Failed: a provider outage stopped the fee job, so no booking lapsed. Fixed: an unreachable provider is skipped and asked again next time |

The claims above are reworded to what these tests show. What a real provider must do, which the stand-in cannot prove, is in `PAYMENT_PROVIDER_REQUIREMENTS.md`. There is still no real provider, and no money moves.

## Not done, and limits

- No real payment provider: choosing one is a paid supplier that depends on the launch country (O-5). Its notification route, signature scheme and status check become a new implementation of the interface.
- The stand-in keeps its checkouts in the API's memory: a restart forgets them, and a status check then answers "unknown"; the booking then waits for its deadline.
- Card gateway payment of freight (P-2) is not this; this is Trucker's fee only.
- A cancellation does not close a checkout in progress at the provider; money taken on it afterwards is recorded for return.
- Refund approval and payment, and reconciliation of mismatched or unknown notifications, are slice 28.
- Wording and layout points are in the final-audit backlog.
- No physical-phone, screen-reader or native Arabic and Urdu review.

## Decisions needed (none blocks the next slice)

- **OP-3 (proposed, not decided).** What makes an online payment in time: the provider's payment time by the deadline (built), or Trucker receiving the word by the deadline? I recommend the provider's time, with the 15-minute wait. It protects a payer whose notification is late only while the provider answers within the wait; beyond it the booking lapses and the payment is returned (PAY-9).
- **OP-5.** Whether receipts must follow a legal numbering or format in the launch country (for example as tax documents). Built as acknowledgements only; a tax adviser should answer.
- O-5: the payment provider itself, and the production values of OP-1, OP-2 and OP-6.
