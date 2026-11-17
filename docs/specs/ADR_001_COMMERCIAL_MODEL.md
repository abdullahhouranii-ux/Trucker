# Trucker ADR-001: revised commercial model, update the existing platform

Version 0.2, 17 November 2026. Decider: Abdullah. Replaces version 0.1 of the same day.

Source of the model: **"Trucker development plan for partners"** (Abdullah, 17 November 2026; Google Doc `Trucker_Updated_Plan_English`, identical to the uploaded copy). References such as "Plan, Pricing" point to its sections.

No legal, tax, licensing or payment-regulation rule is stated here. Questions for advisers are in section 8; they must be answered before production, and they do not stop development.

## How to read this record

| Mark | Meaning | Can change without reopening the model? |
|---|---|---|
| **Confirmed** | Stated in Abdullah's plan. Development follows it and does not reopen it | Only by Abdullah's explicit decision |
| **Default** | My proposed development value or rule, held as a versioned setting or a single rule in code, with no market or legal evidence behind it. Needs approval before production | Yes: changed in settings or one rule, without changing the model or the schema |
| **Open** | Not decided. Each has a recommendation and a working default, so development is not blocked while it waits | Yes, by Abdullah's decision |
| **Design** | How it is built. An engineering choice that carries no business rule | Yes, by review |

## 1. What changed from version 0.1

| Version 0.1 | Version 0.2 |
|---|---|
| CM-4: show the customer a line with the organiser's commission | **Withdrawn.** The customer sees the shipping price and Trucker's fee, with no commission line (Plan, Pricing) |
| Three participant kinds | Six participant types and six roles on each shipment (Plan, Accounts) |
| Commission mainly through standing organiser–carrier agreements | The organiser chooses percentage, fixed amount or contract on each request; the carrier accepts price, commission and net before the agreement is final (Plan, Pricing) |
| Fee payer as an open question (CM-5) | The fee payer is a separate role on each shipment; the settings name the responsible payer (Plan, Accounts and Phase three) |
| Refunds: full refund only | Full **or partial** refund rules, eligibility and processing deadlines in the settings (Plan, Phase three) |
| CM-1 to CM-12 as one list | Split into confirmed requirements (section 3), defaults (section 5) and open decisions (section 6) |
| Build order disputed | The plan's five phases are the order. Running dispatch alongside is a scheduling option only (section 7) |

## 2. Context (checked on 17 November 2026)

| Item | State |
|---|---|
| Built and reviewed | Slices 1 to 16: identity, organisations, verification, staff, shipments, publication, carrier onboarding and discovery, quotations, fleet and drivers, booking with a fixed fee snapshot, assignment with reservations and confirmation, cancellation before dispatch |
| Pull requests | #15 to #22 open, stacked, none merged, all mergeable, CI green. `staging` holds slices up to 10 |
| Fee today | One protected settings row (payer `shipper` or `carrier`, 300 basis points); the booking snapshot fixes payer, rate, rounding and amount, checked exactly by the database. No versioning or approval |
| Confirmation today | Recorded when every required resource is assigned, reserved and eligible. No payment involved |
| Carriers today | Companies only (`carry_as_company`) |
| Your computer | The other assistant's uncommitted slice 16 work on `codex/cancellation`, older than PR #22. `docs/delivery/STATUS.md` dated 13 November, out of date |

## 3. Confirmed requirements

### 3.1 Participants and roles

| ID | Requirement | Status |
|---|---|---|
| R-1 | Six participant types: manufacturer (sends goods, its staff manage shipments, may pay); customer or receiver (receives goods, may create the request or pay); coordinator (a registered individual managing own or explicitly authorised shipments); broker (a logistics or import-export business arranging transport for customers); transport company (offers, fleet, drivers, execution); truck owner (offers an eligible vehicle, may also drive it) | Confirmed |
| R-2 | Each shipment separately identifies its **organiser, sender, receiver, contracting customer, freight payer and Trucker-fee payer** | Confirmed |
| R-3 | Data isolation is preserved for every new participant | Confirmed |
| R-4 | A coordinator cannot manage another party's shipments without that party's authority | Confirmed |

### 3.2 Pricing and commission

| ID | Requirement | Status |
|---|---|---|
| R-5 | When creating a request, the coordinator or broker chooses one commission option: **percentage** (with the amount it is calculated on), **fixed amount** (with amount and currency), or **contract** (a mutually accepted contract defining calculation, earning conditions and settlement terms) | Confirmed |
| R-6 | The organiser commission is **included in the customer shipping price**. Carrier net earnings = shipping price minus commission | Confirmed |
| R-7 | The transport company or truck owner **accepts the shipping price, the commission and its net earnings** before the agreement is final. A commission contract never applies to a carrier that has not accepted it | Confirmed |
| R-8 | Trucker's service fee is **separate** from the shipping price. The commission is not charged again inside the fee. In the plan's example the customer pays the fee: AED 1,000 + AED 30 = AED 1,030, before tax | Confirmed |
| R-9 | The customer sees the shipping price and Trucker's fee, **with no separate organiser-commission line**. The carrier, the organiser and Trucker finance see the detail appropriate to their roles | Confirmed |

### 3.3 Payments and confirmation

| ID | Requirement | Status |
|---|---|---|
| R-10 | Trucker's fee is collected **online or by bank transfer**. Freight is settled separately | Confirmed |
| R-11 | Secure payment links, bank-transfer verification, receipts and reconciliation | Confirmed |
| R-12 | An uploaded transfer slip, or a return from checkout, is **not** proof of payment | Confirmed |
| R-13 | No duplicate charge or booking when a request is retried or a provider notification repeats | Confirmed |
| R-14 | A booking is confirmed only when **both** hold: Trucker's fee is paid and verified, and every required eligible resource is assigned and reserved | Confirmed |
| R-15 | Payment and reservation deadlines are defined, with a refund path when payment succeeds but transport cannot be confirmed. A late bank transfer never silently confirms an expired offer or an unavailable truck | Confirmed (values: section 5) |

### 3.4 Financial settings

| ID | Requirement | Status |
|---|---|---|
| R-16 | Settings screens for: commission options, percentages, fixed amounts, contracts and limits; Trucker fees, calculation methods and the responsible payer; full or partial refund rules, eligibility and processing deadlines; freight and commission settlement deadlines and earning conditions | Confirmed |
| R-17 | Every financial change follows **draft, second-administrator approval, effective date**, with history | Confirmed |
| R-18 | Each booking keeps the exact rules and prices accepted when it was created. Existing bookings and agreements are preserved; accepted terms are never rewritten | Confirmed |

### 3.5 Settlement and operations

| ID | Requirement | Status |
|---|---|---|
| R-19 | First release: the commission is recorded as **payable by the carrier to the organiser**, settled by a separate bank transfer **with payment evidence**. Automatic splitting is deferred | Confirmed |
| R-20 | Freight payments, organiser commissions and refunds are recorded, and outstanding obligations closed | Confirmed |
| R-21 | Delivery and payment are separate statuses: goods can be delivered while amounts are outstanding | Confirmed |
| R-22 | Dispatch checks, driver acknowledgement, milestones, proof of delivery and exceptions are completed against this model | Confirmed |

### 3.6 Scope

| ID | Requirement | Status |
|---|---|---|
| R-23 | GCC-ready; enable only the countries, lanes and payment methods that are ready | Confirmed |
| R-24 | Deferred: wallets, lending, automatic payment splitting, native apps, live GPS | Confirmed |
| R-25 | Functional, security and data-integrity testing continues throughout; wording, translation and cosmetic work goes to the final audit | Confirmed |

### 3.7 Earlier positions this replaces

| Earlier | Now | Status |
|---|---|---|
| DB-5, CB-1: company carriers only | Truck owners eligible to operate independently (R-1) | Confirmed |
| DB-1: recorded bank transfers only, no payment gateway | Fee online or by bank transfer; freight settled separately and recorded (R-10) | Confirmed |
| Slice 15: confirmation without a payment check | Confirmation needs the verified fee as well (R-14) | Confirmed |
| DB-2: fee invoiced after delivery | Fee paid and verified before confirmation (follows from R-14) | Confirmed |
| D-001 consequence: shipper and carrier see the same transport price | Customer sees price and fee; carrier sees price, commission and net (R-9) | Confirmed |
| Broker proposal BR-1 to BR-8: share of Trucker's fee | Organiser commission included in the shipping price (R-6). The proposal's mandate design is kept as the way to give "explicit authority" (D-12) | Confirmed |
| ADR-001 v0.1, CM-1 to CM-12 | Replaced by this version | Confirmed |

**Unchanged:** D-001 (agent: Trucker earns its separate fee; the contract for transport is with the carrier), the reservation and overrun model, staged release of operational details, cancellation before dispatch, exceptions E-1 to E-4, the final-audit rule.

## 4. Design

| ID | Subject | Design |
|---|---|---|
| G-1 | Individuals | A coordinator or truck owner gets a **personal workspace**: an organisation of kind `individual` with exactly one member, verified on personal evidence. Every isolation rule, capability check and audit entry then works unchanged |
| G-2 | Capabilities | New `organise` (coordinator, broker) and `carry_as_owner_operator` (truck owner). A truck owner can be the affiliated driver of their own workspace. Manufacturers and customers use the existing `ship` capability |
| G-3 | Shipment roles | One record per role (R-2), each pointing to a workspace or a recorded contact. Access follows the role; a role sees only what the staged-release rules allow |
| G-4 | Authority | A mandate from the represented workspace: permissions, limits, start and end, withdrawable at once; every action shown as "by X for Y" |
| G-5 | Price breakdown | On each quotation and fixed on the booking snapshot: shipping price, commission option and its inputs, commission, carrier net, Trucker fee and its basis, each payer, currency, minor units, rounding, and the version of every rule used. The database refuses a snapshot whose parts do not add up exactly. Older bookings keep their form (commission zero) through a forward-only migration |
| G-6 | Views by role | Built into the database functions that return a booking, not left to the screens: each role receives only its fields (D-11) |
| G-7 | Settings | Versioned records: draft, approval by a different staff administrator, effective time. Production keeps its gate: it does not start until each setting has an approved version |
| G-8 | Confirmation | Recorded when the **later** of fee verification and full assignment happens, under the same locks the assignment and cancellation commands already take (lock, then read the clock, then decide) |
| G-9 | Bank transfer | The payer gets a reference. One staff member matches the receipt to the bank statement; a second approves. A slip may be attached as evidence but never counts as proof (R-12) |
| G-10 | Online payment | A provider-neutral interface with a test double for development. Only a signed server notification or a server-side status check counts; each notification is stored once by its identifier; amount and currency must match the snapshot |
| G-11 | Late money | A verified payment for a lapsed or cancelled booking never confirms it; it creates a refund record |
| G-12 | Money held | Trucker receives only its own fee. Freight and commission never pass through Trucker |

## 5. Proposed defaults

Development values only, each a versioned setting or a single rule, none approved for production.

| ID | Subject | Default | Status |
|---|---|---|---|
| D-1 | Percentage basis | The customer shipping price | Default |
| D-2 | Rounding | Commission and fee exact, half-up to the currency's minor unit; carrier net = price minus commission, never rounded separately | Default |
| D-3 | Commission limits | Percentage at most 25% of the shipping price; a fixed amount must be below the shipping price and in its currency. Placeholder, no market evidence | Default |
| D-4 | Trucker fee | 3% of the customer shipping price (matches the plan's example and CC-3), half-up | Default |
| D-5 | Fee payer | The shipment's Trucker-fee payer; if none is named, the contracting customer | Default |
| D-6 | Fee deadline | Within 12 hours of acceptance and never after the assignment deadline (same as CC-5) | Default |
| D-7 | Unpaid at the deadline | The booking lapses as a recorded cancellation (`fee_not_paid`): reservations released, nothing charged, the shipment can be published again | Default |
| D-8 | Refunds | Full refund before dispatch in every case (lapse after payment, carrier cancels, carrier misses its deadline, customer cancels) until partial rules are approved (O-4). Each refund approved by a second staff member and recorded within 5 business days | Default |
| D-9 | Freight settlement | The freight payer pays the carrier within 15 days of proof-of-delivery acceptance (CC-4) | Default |
| D-10 | Commission earning and settlement (percentage and fixed options) | Earned when the carrier records receipt of the freight payment; payable within 7 days of that; not earned on a booking cancelled before dispatch. The contract option uses its own terms, chosen from the same list of conditions | Default |
| D-11 | Who sees what | Contracting customer, freight payer and fee payer: shipping price, fee and total. Carrier: shipping price, commission, net (and the fee only if it pays it). Organiser: price, commission, net. A sender or receiver that is neither customer nor payer: no amounts. Trucker finance: everything | Default |
| D-12 | Authority to act for another party | A mandate (G-4). Creating and publishing need the mandate; accepting a quotation on the customer's behalf needs an explicit permission with an amount limit | Default |

## 6. Open decisions

Each has a working default, so development does not wait.

| ID | Decision | Recommendation (and working default) | Status |
|---|---|---|---|
| O-1 | Who states the shipping price | The carrier quotes it in the existing quotation flow. The request shows the commission terms; the quotation screen shows the commission and net before submission; submitting is the carrier's acceptance (R-7). An organiser-stated price for carriers to accept can be added later if needed | Open |
| O-2 | Who may be the contracting customer | The manufacturer or sender, the customer or receiver, or the organiser only for its own goods. A coordinator or broker arranging for others is never the contracting customer: it would then become the carrier's customer and resell the transport, a principal arrangement that the agent model (D-001) does not cover | Open |
| O-3 | Consequence of an overdue commission | While an undisputed commission is overdue, that carrier cannot quote on that organiser's requests. Working default until you decide: the overdue payable is shown to staff and both parties, with no automatic block | Open |
| O-4 | Partial refunds | Which cases are partial and by how much, after the lawyer has seen the terms. Working default: D-8 | Open |
| O-5 | Online payment provider | Depends on the launch country (X-1) and is a paid supplier. Working default: bank transfer plus the provider interface with its test double | Open |
| O-6 | The open pull requests | Review and merge #15 to #22 into `staging` before phase two code starts. Needs your explicit authorisation | Open |
| O-7 | Dispatch slice 17 | DD-1 to DD-10 await approval. It can run alongside phases two to four (section 7) | Open |

## 7. Build plan (the plan's five phases)

| Phase | Work | Needs |
|---|---|---|
| 1. Baseline and specification | This record in the repository; the decision record updated; `STATUS.md` brought up to date; existing pull requests reviewed (O-6) | — |
| 2. Accounts, permissions and commission agreements | Personal workspaces, `organise` and `carry_as_owner_operator`, the six shipment roles, mandates, commission contracts with carrier acceptance | Phase 1. O-2 has a working default |
| 3. Pricing and financial settings | Versioned settings with second-administrator approval; commission options on the request; price breakdown on quotations and bookings; views by role | Phase 2. O-1 has a working default |
| 4. Payments and confirmation | Payment links through the interface and test double, bank-transfer verification, receipts, deadline and lapse, refund records, reconciliation; confirmation needs the fee | Phase 3. O-5 for a real provider only |
| 5. Operations, settlement and closure | Dispatch (17), proof of delivery (18), freight payments, commission payables and refunds (replaces 19), closure (20) | Phase 4 for settlement. DD-1 to DD-10 for dispatch |

Scheduling option, not a model change: dispatch (slice 17) depends only on "the booking is confirmed", so it can be built alongside phases two to four once DD-1 to DD-10 are approved. Each phase still gets its scope and acceptance criteria for approval and its own pull request.

## 8. Questions for advisers (before production; development continues meanwhile)

- The commission is included in the price without a separate line (R-9): confirm this is permitted where the organiser acts for the customer, and what the terms must say.
- Who invoices whom: the carrier to the customer for the shipping price, the organiser to the carrier for the commission, Trucker to the fee payer; and how each is taxed.
- What collecting Trucker's fee online requires in the launch country: merchant account, receipts, refunds.
- Individuals: identity evidence, holding personal data, and any consumer obligations towards individual customers.
- Whether coordinators, brokers or truck owners need a licence, and whether Trucker must check it.

## 9. Engineering safeguards in every phase

- Exact decimal money in minor units; the breakdown checked by the database.
- Snapshots immutable; a settings change never rewrites a booking.
- Payment notifications stored once by identifier; amount and currency matched; a late, repeated or lost answer never charges twice, confirms twice or confirms a lapsed booking.
- Lock, then read the clock, then decide, for confirmation, lapse and cancellation alike.
- Second-administrator approval for financial settings, payment verification and refunds.
- Each role receives only its own fields from the database, never more for a screen to hide.
