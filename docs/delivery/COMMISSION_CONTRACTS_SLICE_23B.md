# Trucker: commission contracts, slice 23b record

Date: 17 November 2026. Branch `feat/commission-contracts`, stacked on PR #26. Built under Abdullah's instruction of 17 November 2026 (11:46), "proceed all slices", and his message of 13:05, "check again then proceed". No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3), requirements R-5 and R-7, not reopened. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Contract | An organiser proposes a commission contract to a carrier, named by its account code. It states the commission (a percentage of the shipping price, or a fixed amount), when it is earned and within how many days it is payable. Nothing applies until the carrier accepts. Either side ends it at once |
| One at a time | At most one proposed or active contract between an organiser and a carrier. Its terms never change; to change them, end it and propose another |
| Contract option on a request | The organiser may choose "the contract with each carrier" as a shipment's commission. Each carrier's commission is then the one in its own contract with the organiser |
| No contract | A carrier with no contract in force with the organiser cannot quote on such a shipment, and its page says why and links to its contracts |
| Acceptance | A contract does not replace the per-price acceptance: no quotation exists unless the carrier also accepted the exact commission and net for its price |
| Ending | Ending a contract stops new quotations, revisions and reconfirmations under it. A quotation sent while a contract is being ended waits for the end and is then refused, never half-applied. Quotations already made and bookings keep the commission the carrier accepted, and record which contract it came from |
| Reconfirmation | Keeps the earlier acceptance only if the figures and the contract are unchanged. Under a new contract, even on the same terms, the carrier accepts the figures again |
| Who sees what | Organiser and carrier see the contract between them. The customer sees no contract and no commission |
| Web | A "Commission contracts" page (account code, propose, accept or decline, end); the contract option on the shipment's commission form; on the carrier's page, its contract terms or the reason it cannot quote. English, Arabic and Urdu |

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| D-3 | The same limits as the other options: a percentage from 0.01% to 25%; a fixed amount above zero, in the quotation's currency, leaving the carrier more than zero |
| D-10 | One earning condition, the one ADR-001 names: the carrier records receipt of the freight payment. Settlement within 1 to 60 days. Both are recorded now and used by settlement, which is not built |
| C-1 | Under the contract option, a carrier with no contract in force cannot quote. It still sees the shipment in discovery |
| C-2 | Ending a contract does not close quotations already made under it. The customer may still accept them; the carrier may withdraw them. **This is a policy choice for you** (see below) |

## How it is built

Migration `0021_commission_contracts.sql`, forward-only. Table `commission_contract`, closed to the API's database role; a trigger refuses any change to its terms or parties, any change after it is declined or ended, deletion and truncation. The contract option is added to `shipment_commission`; `quotation_commission` and `booking_commission` record the contract. The figures are now computed for a carrier (`commission_figures_for`), reading its contract under a share lock. New commands: `propose_commission_contract`, `decide_commission_contract`, `end_commission_contract`, `commission_contracts`. API routes: `GET` and `POST /organisations/:org/commission-contracts`, `POST .../commission-contracts/:id/decision`, `POST .../commission-contracts/:id/end`. The reconfirmation route now takes an optional `commissionAccepted`.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 343 pass, 0 fail (4 new tests in `contracts.test.ts`); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including 4 new contract checks in English, Arabic and Urdu. The first complete run failed three layout checks (contract terms made the page scroll sideways at doubled text size); fixed by showing the terms as a list, and the full rerun passed |
| Console browser checks | All passed |
| Stability | The new tests and the slice 23 tests ran 8 times in a row without failure |
| Deliberate faults | Twelve faults put into the migration one at a time; each was caught by the test meant to catch it |

How the evidence was corrected along the way, so it can be judged:

- A first browser run was cut off by me: a fault script of mine dropped and recreated the shared test database while the run was using it. That run is not counted. Faults now run on a separate database.
- Two tests compared lists in a fixed order where the order is not fixed (records made at the same test-clock instant). They failed some of the time. Both now compare without regard to order; one of them was in slice 23 (CM-2), corrected here.
- My first fault run reported every fault caught. Checked one by one, one catch came from the order failure above, one test never received an edit I thought I had made, and one fault changed nothing observable. Corrected and rerun: the result above.

## Not done, and limits

- Settlement: the earning condition and the settlement days are recorded but not used.
- The 25% limit and the 1 to 60 days are fixed in the migration, not staff settings. They move to phase three settings.
- A carrier that cannot quote for want of a contract still sees the shipment in discovery; it is not filtered out.
- The organiser has no web list of the commissions it has earned; the API provides it.
- Wording and layout points are in the final-audit backlog.
- No physical-phone, screen-reader or native Arabic and Urdu review.

## Decision needed (does not block the next slice)

**C-2. When a contract ends, what happens to quotations already sent under it?** Built: they stay open and the customer may still accept them at the commission the carrier accepted. The alternative is to close them when the contract ends, as quotations are closed when a shipment is withdrawn. I recommend keeping the built behaviour: the carrier accepted those exact figures and can withdraw the quotation itself.
