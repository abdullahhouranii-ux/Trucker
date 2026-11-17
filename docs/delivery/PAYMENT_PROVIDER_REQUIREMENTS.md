# Trucker: what a real payment provider must do

Date: 17 November 2026. Written after the review of slice 27. No payment provider is chosen (ADR-001 O-5); the only one is a development stand-in, and no money moves. This lists what Trucker's code relies on a provider to do, which the stand-in therefore cannot prove. Each item says what happens when a provider does not do it, as far as Trucker's own tests show.

## What Trucker's own code shows, and what it does not

| Claim | Shown by | Not shown |
|---|---|---|
| One checkout in progress per booking, whatever the number of requests | PAY-1, PAY-7 (simultaneous requests) | — |
| A retry after a lost answer reaches the same provider checkout | PAY-7 | Only if the provider honours Trucker's idempotency key (item 1) |
| A notification or status answer is applied once | PAY-2, PAY-6 | — |
| Money taken twice for one fee is recorded and the second payment returned | PAY-8 | That a provider never takes it twice: Trucker cannot prevent that (item 2) |
| A payment taken in time whose notification is late still settles the fee | PAY-4, AUDIT-2, AUDIT-3, PAY-10: whenever the provider answers a status check before the longest wait (OP-7) ends, including for a checkout closed or replaced here | Beyond the longest wait with the provider unreachable, the booking lapses and the payment is returned (PAY-9). It is not protected |
| An outage at the provider does not stop other bookings lapsing | PAY-9 | — |

So Trucker does not guarantee that a payer is never charged twice, nor that a late notification never costs a booking. It guarantees that every payment it is told of is recorded, applied at most once, and either settles the fee or is recorded as money to return.

## Requirements

| # | Requirement | Why | If a provider does not meet it |
|---|---|---|---|
| 1 | Opening a checkout is idempotent on Trucker's checkout identifier | A retry after a lost answer must reach the same checkout | Two payable checkouts can exist; a payer could pay both; the second is returned |
| 2 | A checkout cannot be paid after its expiry time, or Trucker can cancel it | Trucker opens a new checkout once the old one has expired | A payer could pay an old and a new checkout; the second is returned |
| 3 | Notifications are signed over the exact bytes, with a timestamp, and a documented verification (shared key or public key) with key rotation | Only signed notifications count (R-12) | Not usable: Trucker accepts nothing unsigned |
| 4 | Each notification has a stable identifier, and is redelivered with the same identifier until acknowledged | Stored once by identifier (R-13) | Repeats with new identifiers are still applied once, by transaction |
| 5 | A server-side status lookup by the provider's checkout reference, giving the amount, currency, payment time and transaction | Found when a notification is lost (PAY-4) | A lost notification is only found if it is redelivered within the wait |
| 6 | The payment time in notifications and status is the time the money was taken | OP-3 (proposed): in time means taken by the fee's deadline | OP-3 cannot be applied as proposed |
| 7 | The amount taken equals the checkout's amount, in its currency and minor units; no partial capture | G-10 | Anything else settles nothing and waits for reconciliation |
| 8 | Refunds by API, partial and full, idempotent on Trucker's refund identifier, with their own status (submitted, completed, failed) and notifications | Slice 28 | Refunds are carried out by hand and recorded by staff |
| 9 | Settlement reports or an API listing payments and refunds, for reconciliation | Slice 28 | Reconciliation is by hand against the bank statement |
| 10 | Hosted checkout: card details never reach Trucker | Keeps card data out of Trucker's systems | Not acceptable without a separate security assessment |

Choosing a provider, its contract and its fees are Abdullah's decision (O-5); none is contacted from here.
