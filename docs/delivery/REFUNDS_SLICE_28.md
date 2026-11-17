# Trucker: refunds of Trucker's fee, and reconciliation, slice 28 record

Date: 17 November 2026. Branch `feat/refunds` (PR #32), stacked on PR #31. Last slice of phase four (ADR-001 section 7), built under Abdullah's instruction of 17 November 2026 (20:06). No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3): R-11, R-15, R-20 (confirmed), G-11 (design), D-8 (default), O-4 (open). No payment provider is chosen or contacted: the only provider is a development stand-in. **There is no real provider, and no money moves.** Bank refunds are transfers staff make outside Trucker and record here. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Separate steps | Money owed back (the refund records of slices 26 and 27) is paid back through refund requests. Each request is **requested**, **approved**, **submitted**, and ends **completed** or **failed**; it can be **withdrawn**, with the reason, before it is submitted. Each step has its own time and person, and a history entry |
| Independent approval (D-8) | A request is approved by a different administrator from the one who asked. A bank refund is confirmed from Trucker's bank statement by someone other than the one who sent it. The database refuses both, whatever the caller |
| Partial refunds | A request can be for part of what is owed; several requests can pay it back. The requests that have not failed or been withdrawn never add up to more than the payment, nor than what is owed. The database checks this under a lock on the payment, on every insert or change, so it holds for simultaneous requests and for rows written directly |
| What is owed is unchanged | Partial here means paying back in parts. What is owed is still the full amount under D-8; nothing marks the rest as no longer owed. Which cases may be refunded only in part is O-4, still open |
| Provider refunds | Only for online payments. The request is marked submitted before the provider is asked, with the request's identifier as the idempotency key. If the answer is lost or the provider is unreachable, the refund stays submitted and nothing is claimed; asking again (by staff, or by the fee job after a minute) sends the same identifier. A provider refusal leaves it failed with the reason, and the amount can be requested again |
| Provider answers | Applied once. An answer that contradicts a final one (for example "succeeded" after "failed") is recorded in the history and not applied. An answer about a different refund reference is not applied |
| Bank refunds | Staff make the transfer outside Trucker and record its reference; a different administrator records the outcome: completed, with the statement line that shows it left, or failed, with the reason |
| Reconciliation (R-11) | For each approved payment and each completed refund, someone who had no hand in it records what Trucker's bank statement or the provider's report shows. The outcome is worked out, not chosen: matched when amount and currency agree, otherwise a discrepancy, which needs a note and stays listed. A correction names the entry in force and replaces it; the replaced entry stays |
| History | Requests, their history and reconciliation entries are never removed; recorded values never change; a request only moves forward. Withdrawals and corrections are new records, not edits |
| Payer | The booking page shows each amount owed back as not yet processed, in progress, partly returned (with how much so far) or returned. English, Arabic and Urdu. The carrier sees none of it |
| Console | A Refunds page for administrators: money to return, refunds in progress with the step each one is at, what is waiting for reconciliation, open discrepancies, and refunds that ended. It states that nothing there moves money |

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| RD-1 | Every refund and reconciliation step needs the `staff_admin` privilege; there is no separate finance role |
| RD-2 | Any administrator may withdraw a request before it is submitted, with a reason, including the one who asked |
| RD-3 | The fee job asks the provider about provider refunds submitted at least a minute ago with no final answer, up to 50 each run |
| RD-4 | Matched means the same amount, to the minor unit, and the same currency. Anything else is a discrepancy |
| RD-5 | Anyone with no hand in the payment or refund may correct a reconciliation entry, including the one who recorded it |

The defaults of slices 26 and 27 are unchanged, and OP-3 stays proposed, not decided.

## How it is built

Migration `0026_refunds.sql`, forward-only. Tables `refund_request` (with a trigger that refuses any total above the payment or what is owed, and a guard that lets a request only move forward and keeps what each step recorded), `refund_event` (the history, in order) and `reconciliation_entry` (one entry in force per payment or refund; a correction names the entry it replaces), all closed to the API's role. New callable functions: `staff_refunds`, `staff_refund_request`, `staff_refund_decide`, `staff_refund_submit`, `staff_refund_outcome`, `staff_reconcile`, `refund_provider_report`, `refunds_to_check`. Every step locks the payment first, then reads the clock and decides. `fee_refund_values` now also gives how much is returned and in progress; `staff_fee_payments` lists only money not yet fully returned.

API: `RefundService` and routes `GET /staff/refunds`, `POST /staff/refunds` (Idempotency-Key), `POST /staff/refunds/:id/decision`, `/submit`, `/outcome`, `POST /staff/reconciliations` (Idempotency-Key). The payment provider interface gains `refund` and `refundStatus`; the stand-in implements both, refuses to return more than was paid, and can lose an answer, refuse a refund, or be unreachable, for tests.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`payment/refund.test.ts`) | 5 pass, 0 fail: RF-1 (bank lifecycle, two people, idempotent request, history, immutability, closed tables), RF-2 (partial, exceeding refused, withdrawn and failed free their amount, simultaneous requests, direct and concurrent direct writes refused), RF-3 (lost answer, outage, the job retrying, simultaneous submissions: one refund at the provider), RF-4 (provider refusal, contradicting and foreign answers recorded and not applied), RF-5 (independence, outcome worked out, corrections keep the replaced entry, only the entry in force can be corrected, only final payments and refunds are reconciled) |
| Deliberate faults | Fifteen faults in the migration and two in the API, put in one at a time. Twelve were caught at once. Five were missed at first: an outcome sent straight to the database being used, a correction naming another subject's entry, a request moved backwards with a consistent shape, withdrawn requests still counted, and the time and person of a submission changed while it waited. The tests were extended (direct database calls, a backwards move with the version moved on, the whole amount requested again after a withdrawal, a change to a waiting submission), and all seventeen are now caught |
| `npm run verify` | Passed: API 373 pass, 0 fail (5 new); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including 1 new: a fictional double payment on a booking paid online is partly returned through the stand-in by two administrators; the customer sees "partly returned" and the amount so far in English, Arabic and Urdu, with the keyboard, layout and rules checks; the carrier sees nothing of it |
| Console browser checks | All passed, including 1 new: the Refunds page empty, then with a fixed fictional list in every state (keyboard, layout at four widths and doubled text, structure, automated accessibility rules), and a request sent from it refused by the real API and named in the summary, nothing recorded. Found and fixed: the history disclosure and the radio buttons were too small a target, and an inline link on the fee payments page was too small |

## Not done, and limits

- No real payment provider. A provider's refund notifications are not built: only its answer to a refund and a status lookup. What a provider must do is in `PAYMENT_PROVIDER_REQUIREMENTS.md` (items 8 and 9).
- The stand-in keeps its checkouts and refunds in the API's memory: after a restart it knows neither, so a refund asked again is refused and recorded as failed. A real provider must keep idempotency keys (requirement 8).
- D-8's "recorded within 5 business days" is not tracked: no business-day calendar is decided for the launch country. The console lists money owed oldest first, with the date it became owed.
- Payers' bank details are not collected or stored; staff obtain them outside Trucker for a bank refund. Whether Trucker should collect them, and how they are protected, is a decision.
- Notifications that settled nothing (a different amount, or an unknown checkout) are still only listed for staff; they are not part of reconciliation.
- Only discrepancies are offered for correction on the console; a matched entry can be corrected through the API only.
- Freight, commission and organiser refunds are phase five.
- Wording and layout points are in the final-audit backlog. No physical-phone, screen-reader or native Arabic and Urdu review.

## Decisions needed (none blocks the next slice)

- **O-4.** Which cases may be refunded only in part, and by how much. The mechanism is built; no case uses it as a final outcome.
- **RD-1 to RD-5**, and whether a separate finance role should hold refund and reconciliation steps.
- **Payer bank details for bank refunds:** collect them in Trucker (with what protection) or keep them outside.
- **D-8's 5 business days:** the calendar and what happens when it is missed.
- O-5: the payment provider; OP-3 stays proposed.
