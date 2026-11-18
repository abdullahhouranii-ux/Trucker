# Trucker: undeliverable, refused and partly delivered cargo, slice 18d record (R-406)

Date: 18 November 2026. Branch `feat/undeliverable`, stacked on PR #35 (slice 18a). Built under Abdullah's instruction of 18 November 2026 (11:23), which approved the business rules of R-406 for development and testing. It did not authorise a merge, a deployment or a purchase. Nothing here is merged, deployed or approved for production. Slices 18b (proof of delivery) and 18c (disputes and holds in general) are not built. This slice reuses the custody, case, reservation, audit and financial-settings mechanisms of slices 15 to 18a. It is not a warehouse system.

The rules follow the principles of CMR articles 12 and 14 to 16 and Maersk's terms 2.14 as Abdullah's instruction cites them. Neither text is reproduced here, and no legal conclusion is drawn from them. The values below are development defaults, not legal or commercial policy.

## Three separate facts

| Fact | Who records it | Where |
|---|---|---|
| Who may instruct about the cargo | The contracting customer declares it, for itself or for the organiser by mandate | `instruction_authority`: holder, role, basis and its note, the actions covered, the spending limit, an optional end, an alternate contact, who declared it and when. It is never changed, only ended. Its history stays. Paying the fee or the freight gives no right to instruct |
| Who approved a cost, and who pays it for now | The authorised party, when it approves the carrier's offer (or the emergency plan, when nobody answered) | `cargo_instruction` (approval basis, approved total, terms version) and `exception_cost.interim_payer` |
| Who finally bears it | Operations, only from its source: the contract, a settlement or a competent decision, with a reference | `exception_cost.final_liability`, `final_source`, `final_reference`. Trucker documents and mediates. It never decides liability itself |

Approving a cost is not accepting liability for it. Recording a cost, an approval, a liability or a hold moves no money.

## What changed

| Area | Change |
|---|---|
| Shortfall (journey) | Any outcome that leaves cargo on the vehicle now records: the reason (wrong address, receiver absent, site not ready, site closed, receiver refused, cargo damaged, document problem, carrier delay, other), the receiver's reason for a refusal, where the cargo is, its condition, the unit and quantities delivered and not delivered, the attempts to reach the receiver, and notes on contact and evidence. The time stated and the server's time are both kept, as is who recorded it and on whose behalf (E-4). Refused and not delivered mean nothing was delivered; partly delivered needs something delivered. Nothing is ever recorded as delivered in full or cancelled automatically |
| Cargo case | The shortfall opens one cargo case on the trip, next to the operations case of 18a. Its response and escalation times come from the booking's own terms version, by the cargo class of the equipment: general, temperature-controlled, or dangerous goods. The cargo state (on the vehicle, handed over), the instruction state, the execution state and the financial state (costs, liabilities, claims, holds) are separate records |
| Authority | The customer's administrator declares the authority on the booking. For itself, it must state that its contract gives it the right. For the organiser, it gives a mandate naming the actions. A new declaration ends the earlier one, and history is kept. The receiver can be recorded as refusing, with a reason, and gains no right to instruct. Authority is checked again on every step under the trip's lock. An ended or expired authority allows nothing new. A booking's terms snapshot is never changed |
| Instructions | Retry delivery, deliver to another destination, store temporarily, return to the sender, or return to another approved place. At most one instruction is open on a case. Each step names the version it was based on: a stale or simultaneous one is refused, and two can never both run. The carrier answers whether it is feasible, by when, and with its costs. Nothing is carried out before approval, except a protective action under the emergency plan |
| Costs | Separate lines: waiting, handling, unloading, storage, retry, alternate transport, return, other. Each line keeps its quantity, unit (hour, day, trip, item, lump sum), amount per unit, exact amount in the booking's currency and minor units, who offered it, and the terms version. No Trucker fee and no organiser commission is added. Waiting is offered only in hours, and only what was billable: from arrival at delivery until the truck's release, less the free waiting. A return trip fee can be offered only when the booking's terms allow one |
| Liability for now | A cause on the customer's side (wrong address, receiver absent, site not ready or closed) is marked as borne as the contract says. Every other cause is marked as not yet decided, including a refusal and anything the carrier may have caused. The receiver is never charged for being named, and no liability value can name the receiver. A refusal does not cancel the freight |
| Approval | The authorised party approves or declines, within its spending limit. Above it nothing is approved. It also chooses who pays for now (itself or the carrier). The page says plainly that approving does not decide who finally bears the cost and moves no money |
| No answer | Silence approves nothing. After the response time with no approved instruction, the trip watch escalates the case to operations, once. Only then may the carrier take a protective action, and only an action in the booking's emergency plan, within its cap. The carrier pays for it for now. It withdraws any instruction still waiting. Selling, destroying, abandoning or taking cargo across a border is not an action |
| Competent authority | Operations records what a competent authority ordered and which actions it allows. From then only those can be instructed, and an open instruction outside them is withdrawn. The app cannot go beyond it |
| Custody | A handover now records who handed over and who received (each with their standing), where, when, the quantity, the condition, the evidence and the instruction it was carried out under. Kinds added: warehouse, alternate carrier, consignee. A handover moves custody only when the receiving side's receipt is confirmed, recorded by the customer's administrator, the organiser with authority, or operations, with its reference. Never by the carrier. A rejected receipt moves nothing |
| Further legs | Retry, another destination and return carried out by the same truck are legs of the original trip, each with its own progress (planned, departed, arrived, completed) and delivery (quantity and receiver). The booking and its trip are never rewritten. While a leg is under way the resources stay occupied: no release by anyone, not even an operations override. Nothing pretends the truck is free |
| Releases | Each resource is released on its own recorded condition, as in 18a. Neither a shortfall, a storage instruction nor a handover alone releases anything. Custody is open while any cargo is on the vehicle: the quantity not delivered, less confirmed handovers and completed legs. A resource can be released after a safe, confirmed handover while a cost dispute or claim stays open. Waiting stops at the truck's release, while storage may continue |
| Claims and holds | The authorised side may dispute costs or claim the carrier was at fault. Each places its own hold on the named costs, owned by that cause. A claim changes no amount and is not proof of fault. A hold is released only when its own cause is decided: the claim decided from its source, or every disputed cost given a final liability. Closing the case or deciding another cause releases nothing else. Unrelated money is not held |
| Lost answers | Every cargo command carries a retry key. Sent again with the same key, it gives the first answer and does nothing twice. With other content, it is refused |
| What each side sees | The driver sees only instructions approved for them to carry out, and the legs; no costs, authorities, claims or holds. The carrier sees costs and authorities but not the alternate contact. The customer, the organiser and operations see all of it. Other organisations see nothing |
| Settings | The financial settings gain response times per cargo class, escalation, free waiting, the currency and reference rates for waiting and storage, the emergency plan and its cap, and the return trip fee policy (none, or offered by the carrier). They follow the same versions, second-administrator approval, effective time and audit as the other figures. A booking keeps the version it was accepted under |
| Web | The booking page shows the cargo case to the customer and the carrier with the forms of each side. The driver's phone shows the approved instructions and the legs. The organiser has a "Cargo cases you instruct" page. The delivery and handover forms carry the new fields. A handover without a confirmed receipt is shown as not yet moving custody. English, Arabic and Urdu. The confirmation "Custody is closed" after a handover was misleading and is corrected |
| Console | The operations queue lists cargo cases, escalated and overdue first. The operations booking page shows the case and offers: a competent authority's instruction, recording a receipt, the final liability from its source, a claim decided from its source, releasing a hold whose cause is decided, and closing the case. The finance page drafts the new settings |

## Development defaults used (not approved for production)

| ID | Default | Why it needs a decision |
|---|---|---|
| UD-1 | The customer declares the authority on the booking after acceptance, not in the acceptance flow. Until it does, nobody may instruct and the case escalates | R-406 asks for the authority at booking. Putting the declaration into acceptance changes the acceptance step (slice 14) |
| UD-2 | Response times 240 minutes (general), 60 (temperature-controlled), 30 (dangerous goods); escalation 60 minutes later; free waiting 120 minutes | Values per country and cargo class are commercial and operational policy |
| UD-3 | Reference rates in the test currency XTS: 10 per hour waiting, 25 per day storage. They are shown for reference only; the carrier's offer states the amounts | Real rates and currencies per market |
| UD-4 | Emergency plan: temporary storage only, up to 100 in the booking's currency; the carrier pays for it for now | Which protective actions are acceptable without an answer, and the cap, are commercial and legal decisions |
| UD-5 | Return trip fee: none | R-406 allows one only under a clear accepted policy |
| UD-6 | Provisional liability: as the contract says for wrong address, receiver absent and site not ready or closed; otherwise not decided | The mapping of causes to the contract's terms |
| UD-7 | A receipt from a warehouse, consignee or other carrier is recorded by the customer, the organiser with authority, or operations, with its reference. The receiving business is not a Trucker user | Whether the receiving business should confirm in Trucker itself |
| UD-8 | Handing cargo to another carrier is recorded as a handover; it creates no booking with that carrier | A new transport order with another carrier would need its own booking, fee and confirmation |
| UD-9 | Final liability values: the contracting customer, the organiser, the carrier, shared, or another party | Whether "shared" needs a recorded split |
| UD-10 | Competent authority instructions are recorded by any staff member with the operations privilege | Whether this needs a second person |

The emergency numbers to show per country stay open (slice 17b).

## How it is built

Migration `0031_undeliverable.sql`, forward-only. New tables, all closed to the API's role and forward-only by trigger: `instruction_authority`, `delivery_shortfall`, `cargo_case`, `cargo_instruction`, `trip_leg`, `exception_cost`, `carrier_claim`, `settlement_hold`, `cargo_handover_receipt`, `cargo_command` (the retry-key log). `cargo_handover` gains quantity, unit, condition, standings, evidence and instruction. A partial unique index keeps one open instruction per case. `financial_setting_version` gains the exception settings, with checks and the same guard. New callable functions: `cargo_command`, `staff_cargo_command`, `organiser_cargo_cases`, `booking_authorities`. Changed: `delivery_outcome_add` (shortfall and case), `cargo_handover_add` (quantities and confirmation), `resource_release_add` (custody by quantity, legs), `trip_values`, `delivery_values`, `overrun_note` and `trip_watch` (escalation), `staff_operations_queue`, `booking_consistency` (a release with cargo on the vehicle, a release while a leg is under way), and the financial settings functions.

API: `POST /organisations/:id/bookings/:bookingId/cargo` (Idempotency-Key), `GET /organisations/:id/bookings/:bookingId/authorities`, `GET /organisations/:id/cargo-cases`, `POST /me/driver/assignments/:bookingId/cargo`, `POST /staff/operations/bookings/:id/cargo`. The delivery and handover bodies gain the new fields. The financial draft accepts the new settings.

The 18a tests now give the shortfall and the handover's quantity, condition and standings, and confirm the receipt before a release: that is the new rule, not a weaker check.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`trip/undeliverable.test.ts`) | 9 pass, 0 fail, covering the 14 required tests: UD-T1 (no authority, outside the mandate, expired, ended while the instruction waited for the lock), UD-T2/T3 (simultaneous and stale instructions, approvals at once, a retried offer with one key), UD-T4/T5 (a refusal charges nobody, no liability can name the receiver, a claim holds and changes nothing, the spending limit), UD-T6/T7/T8 (partial quantities, an unconfirmed or rejected handover moves no custody, recording releases nothing), UD-T9 (release stops waiting, storage continues, the dispute's hold stays), UD-T10 (a return leg keeps occupancy, no release by anyone during it, booking and trip unchanged, no return fee without the policy), UD-T11 (silence approves nothing, one escalation, emergency only after the response time, in the plan and within the cap, no selling), UD-T12 (holds by cause; closing the case releases none), UD-T13 (what each side sees; other organisations see nothing). Connection failure: the web shows "not confirmed" and resends the same key (UD-T3 proves a resend repeats nothing) |
| Settings test (`staff/finance.test.ts`, FS-5) | Pass: the new settings are checked, drafted and approved by a second administrator; a draft without them keeps those in force; a booking keeps its version |
| Updated 18a tests (`trip/delivery.test.ts`) | 6 pass: they now give the shortfall and handover details and confirm the receipt before a release |
| Deliberate faults | Fourteen faults in `0031`, one at a time. Thirteen were caught at once. One was missed at first (the driver shown the costs) and is now caught by an added check in UD-T13 |
| `npm run verify` | Passed: API 416 pass, 0 fail; web 24; console 9 |
| Builds | Passed |
| Browser checks | Web: all passed. The delivery journey now goes through a partial delivery with its shortfall, a refused release, the authority declared, storage instructed, costs offered and approved, the handover to a warehouse shown as not yet moving custody, the release still refused, the receipt confirmed, and the truck and driver released; the cost stays 50.00, paid for now by the party who approved, with no final liability. Found and fixed: checkboxes and radio buttons without their own label and text fields without a type were too small to tap and unlabelled for the checks. Console: all passed, including the operations cargo panel with a fictional case |

## Not done, and limits

- Proof of delivery (18b) and the general dispute and hold flows (18c). Holds here are records; no settlement applies them yet.
- No notification is sent to anyone; escalation shows in the operations queue.
- A new transport order with a different carrier (UD-8).
- The acceptance flow does not yet ask for the authority (UD-1).
- Times are entered in UTC, as on the other trip forms.
