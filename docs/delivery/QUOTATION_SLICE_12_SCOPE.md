# Trucker: quotation slice 12, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **approved by Abdullah on 15 November 2026, QB-1 to QB-11 as recommended, with the safeguards in section 0.** Built on branch `feat/quotations` (record: QUOTATION_SLICE_12.md). Sources: `docs/specs/STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md` sections 3, 5, 6 and 9 to 12 (journeys J3 and J4, AT-203, AT-211 to AT-214); the decision update of 14 November 2026 (D-001 decided: agent; D-001a, D-001b and D-005 open); slices 10 and 11 (slice 11 on PR #15, unmerged).

No price, fee, currency rule, tax treatment or payment rule is proposed or chosen in this document. Where one is needed it is listed as a decision.

## 0. Approval and safeguards

Release 1 is planned as an invitation-only shipment-and-quotation pilot: registration, organisation verification, publication, carrier discovery and comparable quotations. No acceptance, booking, vehicle commitment, invoicing or payment.

QB-1 to QB-11 are approved as recommended, with these safeguards:

| ID | Safeguard |
|---|---|
| SG-1 | One currency per shipment, locked once any quotation exists for it |
| SG-2 | Amounts are exact decimals: no binary numbers anywhere between the form and the database |
| SG-3 | Fictional inclusions only, until the real register is approved |
| SG-4 | Every quotation answers every inclusion of the shipment's terms, so quotations are comparable |
| SG-5 | Suspension never pauses quotation expiry; on resumption each open quotation is judged again for eligibility, validity and reconfirmation |
| SG-6 | The limits of QB-11 are development defaults only. Production fee, tax and inclusion rules remain explicit release decisions |

## 1. What this slice is

A verified carrier that can discover a shipment (slice 11) submits a **quotation** for it: an amount, a validity, an earliest pick-up it can meet, and notes. It can revise the quotation, which creates a new numbered version, or withdraw it. The shipper's administrators see every quotation on their shipment, compare them and may reject one. Quotations expire at their validity by the database clock, with no worker needed. Staff read quotations in the console, read-only.

**Acceptance is not in this slice** (QB-2): nothing is accepted, awarded, booked, reserved, invoiced or paid. The slice ends where the shipper has comparable, current quotations.

Production stays closed by the same gates as slices 10 and 11, and by the decisions in section 6.

## 2. Out of this slice

The following are not in this slice:
- acceptance, award, booking, reservation and the availability flag (sections 6, 7 and 7.1 of the specification);
- Trucker's fee in any form: no computation, no display and no field (D-001a, D-001b);
- payment, deposits, payout and invoices (D-002);
- naming trucks, trailers or drivers on a quotation (the fleet slice does not exist yet; P-201);
- shipper counter-offers (QB-6);
- fixed-price booking (D-005);
- price guides (C-26), contracted lane rates (C-43) and invited-carrier lists (C-41);
- notifications by email, SMS or push: the state shows in the application only;
- partner API access.

## 3. How it works

| Topic | Proposal |
|---|---|
| Who quotes | An administrator of an organisation that can discover the shipment at that moment: every slice 11 condition is checked again inside the quotation function, after its locks and with the database clock |
| Who sees | A quotation is visible to its author's administrators, the shipper's administrators and staff (AT-212). A carrier never sees another carrier's quotation or price. The shipper sees the carrier as decided in QB-5 |
| One open quotation | At most one open quotation per carrier organisation per shipment (AT-214), enforced by the database |
| Fields | Amount and currency (QB-3), what the amount includes (QB-4), validity until, the earliest pick-up the carrier can meet (in the pick-up place's time zone), notes. No resource is nominated (QB-7) |
| States | `submitted` → `withdrawn` by its author, `rejected` by the shipper, or `expired` at its validity. `accepted` and `not_selected` belong to the acceptance slice |
| Versions | Each revision of amount, inclusions, validity or earliest pick-up is a new numbered version. Earlier versions stay readable, and only the latest is current |
| Validity | Required, in the future, and within the limit QB-8 decides. Expiry is judged by the database clock at every read and recorded once, under the quotation's lock, dated at the validity end, as for shipments in slice 10 |
| The shipment changes | A material change to the shipment (PB-3) marks every open quotation as needing re-confirmation on the new version (AT-203, QB-9). Until the author confirms or revises, the quotation is shown with that mark |
| The shipment ends | When the shipment is withdrawn or expired, or its suspension blocks quoting (PB-5), new quotations and revisions are refused. What happens to quotations already open is QB-10 |
| Retries and races | Every command carries a retry key and the version it was made against, as before. A lost answer is reported as not confirmed. Concurrent submissions, revisions, withdrawals, shipment changes and requests crossing a validity end are tested |
| History | One audit entry per transition (`quotation.submitted`, `quotation.revised`, `quotation.withdrawn`, `quotation.rejected`, `quotation.expired`, `quotation.reconfirmation_required`), each exactly once |
| Access log | Reading a shipment through quoting adds nothing new to the slice 11 log. Each quotation read by the shipper or staff is recorded |

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| QUO-1 | Only an organisation that may discover the shipment at that moment can quote. An ineligible, unverified or revoked organisation, and the shipper itself, are refused exactly as for a shipment that does not exist (AT-211) |
| QUO-2 | A quotation is visible only to its author, the shipper and staff (AT-212); a test fails if any other organisation's request returns any part of it, including through lists, errors or counts |
| QUO-3 | A second open quotation from the same organisation for the same shipment is refused, including under simultaneous requests (AT-214) |
| QUO-4 | Each problem in a quotation is reported by field in three languages: the amount and its precision for the currency, validity in the past or beyond the limit, an earliest pick-up outside the window, and inclusions not in the approved list |
| QUO-5 | A revision creates a new version; earlier versions stay unchanged and readable; only the latest is current |
| QUO-6 | Expiry happens at the validity end by the database clock, without a worker, and is recorded exactly once, including for a request that waited behind a lock |
| QUO-7 | A material shipment change marks open quotations for re-confirmation in the same transaction, once per quotation and version (AT-203) |
| QUO-8 | When the shipment is withdrawn, expired or suspended, new quotations and revisions are refused at the moment of the request; open quotations follow QB-10 |
| QUO-9 | The same command with the same key applies once; a different command with the same key is refused; a stale version is refused; a lost answer is checked in the browser for submission and withdrawal |
| QUO-10 | The API's database role cannot read or write quotations except through their functions; this is tested as that role, and the hardening lists are regenerated |
| QUO-11 | No fee, payment, booking, award, reservation, invoice or resource field, route, word or screen is added |
| QUO-12 | Carrier, shipper and console screens pass the existing checks in English, Arabic and Urdu at phone widths with text doubled; amounts and currency codes read left to right in right-to-left text |

## 5. Decisions (approved 15 November 2026 as recommended)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| QB-1 (D-005) | Pricing mechanism | (a) carrier quotations, with negotiation added later; (b) shipper sets a fixed price, the first eligible carrier takes it; (c) both | **(a).** It fits the agent model, where the carrier names its own price, and needs no price-setting rule from Trucker. Fixed price can follow as a variant once quotation data exists |
| QB-2 | Where this slice stops | (a) quotations only, with acceptance in its own slice; (b) include acceptance | **(a).** Acceptance creates a booking, reservations and a terms snapshot. It needs D-001a/b (fee), the fleet slice for resources, P-201 and P-207. Building it now would mean inventing those |
| QB-3 | Currency of a quotation | (a) one currency per shipment, chosen by the shipper from the currencies configured for its pick-up country; (b) the carrier chooses; (c) one currency for the platform | **(a).** Comparing quotations needs one currency per shipment, and the country configuration already carries country rules. No real currency is configured until launch countries are decided (D-003b); development uses the ISO 4217 test code `XTS` with a fictional precision |
| QB-4 | What a quoted amount includes | (a) one all-in transport amount plus a checklist of inclusions from a register you approve; (b) one amount and free-text notes only; (c) itemised charges | **(a)**, with an empty register in production and fictional entries in development. Free text alone makes quotations hard to compare; itemised charges invite pricing rules that are not decided. The items for the register (for example tolls, loading or border costs) are your choice, not mine |
| QB-5 | What the shipper sees of the carrier before acceptance (open in the specification) | (a) the carrier's name and verification status; (b) hidden until acceptance | **(a).** Under the agent model the shipper contracts with the carrier, and the decision update expects the carrier to be "usually visible". Hiding it would also need a rule for contact attempts. Carriers stay unable to see one another |
| QB-6 | Negotiation in this slice | (a) the carrier revises its own quotation, with no shipper counter-offers yet; (b) counter-offers from both sides with a round limit (P-202) | **(a).** Shipper counters only matter when they can be accepted, so they belong with acceptance; P-202 can be decided then |
| QB-7 | Resources on a quotation | (a) none; the quotation is for the carrier's declared equipment type; (b) wait for the fleet slice | **(a).** It lets quoting be proven now. Acceptance will still require verified resources. The quotation states that it is not a commitment of named vehicles |
| QB-8 | How long a quotation may stay valid | (a) not after the shipment's quotation deadline (as the specification has it), so the shipper decides before the deadline; (b) up to a set time after the deadline, giving the shipper a decision window; (c) the carrier chooses freely | **(a)** for this slice. It matches the specification and needs no new rule. If you want a decision window after the deadline, it changes shipment expiry and needs (b) with a length you set |
| QB-9 | Open quotations after a material shipment change | (a) marked for re-confirmation; the author confirms as-is or revises; (b) withdrawn automatically | **(a)**, as AT-203 states. Automatic withdrawal throws away quotations a carrier may still stand by |
| QB-10 | Open quotations when the shipment is withdrawn, expires or is suspended | (a) withdrawn shipment: open quotations close as "shipment withdrawn"; expired: they also expire (follows from QB-8a); suspended: they stay open but cannot be revised, and resume with the shipment; (b) everything closes at any of the three | **(a).** It follows PB-5 (suspension never cancels work) and keeps each cause separate |
| QB-11 | Minimum validity and quotation limits | Protected settings with development defaults needing production review: a minimum validity of 15 minutes, at most 100 open quotations per carrier, at most 5 versions per quotation | Approve them as development defaults only, as for SD-5 |

## 6. Decisions that block production use, not this build

| ID | Decision | Why it blocks production quoting |
|---|---|---|
| D-003b, D-003c | Enabled countries and first lanes. **Undecided**; Middle East target with GCC priority | Nothing is publishable, so nothing can be quoted; no real currency is configured |
| QB-3, production | The real currencies per country, with their precision | Only the test code exists |
| QB-4, production | The real inclusions register | Empty in production |
| D-001a, D-001b | Who pays Trucker's fee, and how it is set | No quotation can be shown to a real shipper without knowing what the fee adds |
| D-001c | Contract wording, liability, invoicing and tax treatment as an agent, including whether quoted amounts are stated with or without tax | Needs lawyer and accountant review. Nothing in this slice states a tax treatment; amounts are labelled "as quoted by the carrier" |
| E-4, SEC-01, terms | As for slices 9 to 11 | Production verification, staff use and registration are closed |
| Access log retention | Carried from slice 11 | Unresolved production requirement |

## 7. Routine choices (made during the build, reported, not asked)

Storage layout, function and route names, how versions are stored, the comparison layout for the shipper, the money type and its database checks, test design, and console labels.

## 8. Carried forward, unchanged

- All production gates in `SECURITY_BACKLOG.md`.
- SEC-01 open and deferred, blocking production and real staff use.
- The staging CI diagnosis behind PR #9 stays "inferred".
- The slice-4 unexplained API test failure is unresolved.
- Development-default settings need production review.
- Test accounts and fictional data only.
- Wording and translation corrections go to the final-audit backlog.
