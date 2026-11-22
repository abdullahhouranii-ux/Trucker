# Trucker: acceptance and booking slice 14, record

Date: 15 November 2026. Branch `feat/booking`, stacked on `feat/fleet` (PR #19), which is stacked on PRs #18, #17, #16 and #15, all unmerged. Scope: BOOKING_SLICE_14_SCOPE.md.

Nothing is assigned, reserved, occupied, confirmed, cancelled, invoiced or paid. No tax is calculated or stated. Every commercial value is a development default.

## What was built

| Part | What it does |
|---|---|
| Migration `0013_bookings.sql` | Commercial settings; shipment state `awarded`; quotation states `accepted` and `not_selected`; the booking table and its retry keys. The API role has no table rights |
| Settings (BC-1) | Fee payer (shipper), fee in basis points (300), payment days (15), assignment hours (12) and lead hours before pick-up (6), positioning (120 minutes) and completion (720 minutes) buffers. Protected, changed only by the migration role, and outside a marked database acceptance answers `closed` |
| Acceptance (BC-3) | One function, one transaction. Locks: both organisations, then the shipment, then all its quotations; then the clock; then any expiry that is due is recorded; then every check. The shipment row lock and two unique indexes (one booking per shipment, one accepted quotation per shipment) make a second booking impossible |
| Snapshot (BC-2) | The booking stores the quotation version exactly as the carrier wrote it, each inclusion with its answer and name, the shipment as carriers saw it, the transport price, the fee payer, rate, rounding and amount, the payment days, the four window times, the assignment rule and deadline, and the planned reservation interval with its buffers. A trigger refuses every update and delete |
| Terms reference (added 15 November, before merge) | A register of booking terms: each version is immutable and carries a hash of its own content. A booking names the exact version and that hash, and both parties are shown it, before accepting and on the booking. The register ships empty and accepts **demonstration terms only**, loaded as a development fixture into a database marked for development or test. It refuses any other kind, and a database holding demonstration terms cannot be marked production. With no version in the register, acceptance answers `closed`. The demonstration text is a placeholder: not legal text, not reviewed, binding on nobody |
| Refusals recorded (added 15 November, before merge) | Every refusal given to an administrator of the shipper is written to that shipper's history against the quotation: the reason, the version asked for and, for a stale version, the current one. That is exactly what the caller is told. Nothing is written to the carrier's history, and nothing at all for a caller who may not see the quotation (they are answered as for a missing record) |
| Fee | `round(price × basis points ÷ 10000, minor units)` in exact numeric, which is half-up for a positive amount. A table constraint requires the stored fee to equal that figure |
| Short notice (BC-4) | The deadline is the earlier of acceptance plus 12 hours and 6 hours before the pick-up window opens. If that is not after the moment of acceptance, acceptance is refused as `assignment_deadline_passed`. A table constraint refuses a booking whose deadline is not after its acceptance |
| Not confirmed (BC-5) | The only booking state that exists is `awaiting_resources`. It is not stored on the booking row: the row is an immutable snapshot, and a later state follows from the records of assignment and reservation. The planned interval on the booking is a plan: no reservation or occupancy record exists yet |
| Before accepting | The shipper sees, for each open quotation, the price, the fee, the total, the payment period and the assignment deadline, or the reason it cannot be accepted now |
| Reading | Both parties read the same booking with the same figures. Staff read it in the console; each look is audited |
| Follow-on effects | An awarded shipment is no longer discoverable and its quotations cannot change. The carrier's quotation list leads to the booking |
| Web | Acceptance and the booking on the shipper's quotations page; a bookings page for either party; corrected statements that said nothing can be accepted. EN, AR and UR (AR and UR drafts, TR-20) |

## Consequences to know about

| Consequence | Note |
|---|---|
| The carrier now sees the shipper's name | From acceptance the booking shows both parties by name, because they contract with each other under the agent model. Addresses, contacts and access notes are still not shown to the carrier. What the carrier sees, and when, is a decision for slice 15 (AB-1) |
| A slice 12 test was changed | It asserted that no acceptance route exists. Acceptance is now an instructed feature with its own tests; the test still asserts that no fee, payment, invoice or confirmation route exists |
| A shipper who never gets its resources assigned | The booking stays `awaiting_resources` past its deadline. What follows a missed deadline (DB-7) is built with slice 15 |

## Evidence

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 303 pass, 0 fail, 0 todo; web 24; console 9 |
| Booking API tests | 10 tests, all pass, including the terms register and the refusal records |
| Deliberate defects in 0013, each caught | Fee truncated instead of rounded; short-notice check removed; snapshot guard removed; other quotations left open; retry not recognised; version not checked; expiry not recorded first; locks removed; standing not checked; any organisation may accept. Migration restored, byte-identical |
| Web browser checks | All passed, including 4 booking checks and a lost acceptance answer leaving one booking; three languages with text doubled |
| Console browser checks | All passed |

## Not covered or still open

- Assignment, reservation, occupancy and confirmation: ASSIGNMENT_SLICE_15_SCOPE.md, for approval.
- Production values for every commercial setting, tax presentation, and the launch geography.
