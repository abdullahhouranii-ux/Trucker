# Public shipment board and fleet gate at quotation

Implemented by Codex locally (unreviewed branch `codex/unified-experience-mobile`) and split into its own branch, `feat/public-shipments`, on 22 November 2026, stacked on `feat/financial-completion`. Migration 0039 (same number as Codex's).

## Behaviour

- **Public board.** `GET /public/shipments` needs no sign-in. It lists open shipments: published, before their deadline, not suspended, from a shipper who may publish, on an open route. Each card shows only the pick-up country, the delivery country, the equipment type and the quote deadline. Twenty per page, with a cursor. The web home page shows the board in English, Arabic and Urdu; a signed-in person also sees an "Open quotation" link.
- **Choosing the account to quote with.** `/[locale]/shipments/[id]/quote` lists the person's carrier accounts and says when none is eligible.
- **Fleet gate.** A carrier can quote only when it holds an active, verified, unsuspended truck that carries the shipment's equipment, or a tractor unit with such a trailer. Otherwise the quotation is refused with `fleet_mismatch`. The board itself is not filtered by fleet.
- Existing tests that submit quotations now give the carrier a matching truck first (`testing/quotation-fleet.ts`).

## Verification (22 November 2026)

Node 24, isolated PostgreSQL, this branch alone.

| Check | Result |
| --- | --- |
| `npm run verify` | API 428 pass, 0 fail, 2 skipped (the two browser journeys, which pass when enabled); web 24/24; console 9/9 |
| Browser journey (`TRUCKER_QUOTATION_BROWSER=1`) | Passes: a carrier signed in sees the card, is refused without a matching fleet, quotes once the truck is added, and the shipper books. Codex's steps for the operations workspace were moved to the redesign branch |
| Deliberate faults in 0039 | Seven, one at a time. Six caught: unpublished shipments listed, expired shipments listed, a suspension ignored, no fleet gate, a tractor without a trailer accepted, an unverified truck accepted. Five were missed at first; a test of the board's and the gate's edges was added. The seventh, the shipper's publishability check, is not caught on its own because withdrawing a shipper's verification also suspends its shipments, which the board already excludes |

## Decisions

Approved by Abdullah on 22 November 2026:

1. **Visibility.** Anyone, without signing in, sees the route countries, equipment and quote deadline of every open shipment.
2. **Fleet gate.** Quoting requires a matching verified fleet; a tractor needs a matching trailer.
