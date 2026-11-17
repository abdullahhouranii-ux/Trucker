# Trucker: shipment roles and authority, slice 22 record

Date: 17 November 2026. Branch `feat/shipment-roles`, stacked on PR #24. Scope: `SHIPMENT_ROLES_SLICE_22_SCOPE.md`, approved by Abdullah on 17 November 2026 (10:36) with S22-1, S22-2 and S22-3 as recommended and six further tests. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md`. Nothing is merged or deployed; DD-1 to DD-10 are not approved. Test accounts and fictional evidence only.

## What changed

| Area | Change |
|---|---|
| Account code | Every account has a code. An organiser names a customer by it; a code that names nothing, the organiser itself or an unverified account gets one and the same answer |
| Authority | The organiser asks; nothing exists until the customer's administrator accepts and chooses what it allows: publishing in its name, and paying Trucker's fee on those shipments. Either side ends it at once. Both sides have the history |
| Roles | Every shipment records organiser, contracting customer, sender, receiver, freight payer and fee payer. An organiser sets them on a draft; they are fixed once the shipment has been published, and copied to the booking at acceptance |
| Organiser recorded | On a shipment arranged for a customer, and on an organiser's own shipment, the organiser is recorded at publication, so the commission slice can tell who organised each booking. A plain shipper's shipment has none |
| Fee payer | The contracting customer or the organiser, no one else. Each must have agreed: the organiser by naming itself (its own act), the customer in the authority it gave. How and when is recorded at publication. Without the customer's agreement, publication is refused |
| Acceptance | Only the contracting customer accepts. The booking's shipper is the customer; the organiser is not a party, and cannot read or cancel the booking |
| Customer's view | The customer sees every shipment arranged in its name with who arranged it, and reads its quotations |
| First-time broker | A company that has never been verified can apply as an organiser and nothing else, in the API and on the verification page |
| Web | An "Authorities" page (code, request, accept or decline, end, shipments arranged for you); a roles section on the shipment page. English, Arabic and Urdu |

## One design change from the approved scope

The scope (S-8) said a shipment arranged for a customer would be kept in the customer's account. It is kept in the **organiser's** account, with the customer named on it as the contracting customer. Reason: your added requirements (two organisers serving one customer, access limited to the shipment) follow from that directly, with no existing access rule changed: each organiser reaches only what it arranged, and nothing else of the customer's account. What the scope promised still holds: the customer sees everything arranged in its name, alone accepts, and is the booking's shipper.

Other differences from the scope text:

- A refusal after the authority has ended is "no authority in force" (the shipment is the organiser's own record), not "record does not exist".
- Reading quotations is not a separate permission: the organiser reads the quotations of the shipments it arranged.
- An authority has no end date yet; it lasts until either side ends it.
- A sender or receiver is the customer, a named party, or not named (the party at the address). Naming another Trucker account as sender or receiver is not built. Shipments made the existing way default to "sender: the customer; receiver: not named", so nothing is invented.
- The customer cannot itself withdraw a shipment an organiser published for it; it ends the authority, which stops changes and republication, and it need not accept any quotation.

## How it is built

Migration `0019_shipment_roles.sql`, forward-only: `organisation.account_code`; tables `organiser_authority`, `shipment_party`, `booking_party` (written once by a trigger when a booking is made; update, delete and truncate refused); functions for requesting, deciding, ending and reading authority and for reading and setting roles; `party_problems` joined to the publication checks. Replaced with their latest definitions and the named change: `publication_problems`, `accept_quotation`, `booking_overview`, `shipment_quotations`. The `booking` table and its snapshots are not altered; earlier bookings get their roles (the shipper's own) in the new table.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 333 pass, 0 fail (6 new tests in `authority.test.ts`); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including 6 new checks in English, Arabic and Urdu. The first run failed two accessibility checks (a text box too small to tap; a list wider than the screen at doubled text size); both fixed, and the full rerun passed |
| Console browser checks | All passed (243) |
| Deliberate faults | Nine faults put into the migration one at a time were each caught by the new tests: the organiser may accept; the booking's shipper is the organiser; authority not checked at publication; fee agreement not checked; another organiser's authority usable; an unverified account can be asked; own organiser not recorded; booking roles can be rewritten; roles editable after publication |

The requested tests: two organisers serving one customer; access limited to the shipment; an authority ended while a publication waits behind a lock (the publication is then refused and nothing is published); explicit fee-payer agreement; booking snapshot and roles unchanged after the authority ends, the capability is withdrawn and the fee setting changes; first-time broker onboarding.

## Found during this slice

A defect in slice 21: two simultaneous attempts to become one's own driver and to accept a company's invitation could deadlock and answer with a server error. Fixed on PR #24 (see its record) and merged here.

## Not done, and limits

- Commission (slice 23), pricing, payments: not in this slice. The fee payer recorded here is not yet what the booking's fee line uses; that is phase three.
- Messages for the new publication refusals fall back to the general "check the details" text on the publication form; specific wording is in the final-audit backlog.
- No physical-phone, screen-reader or native Arabic and Urdu review.
