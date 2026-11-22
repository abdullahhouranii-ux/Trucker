# Trucker: a broker role, proposal and decisions

Version 0.1, 15 November 2026. Status: **proposal for Abdullah's decision. Nothing here is built, and it is outside the Release 1 definition until approved.** Raised by Abdullah on 15 November 2026: brokers who already have good relations with truckers and many customers, and already earn commissions, should get their own kind of account to manage their activity and earn a commission under an agreement with Trucker.

No legal, tax or licensing rule is stated here. The questions for advisers are listed in section 7.

## 1. The recommendation in one paragraph

Treat a broker as a **verified organisation that acts for others under a written mandate**, never as a hidden middle layer. The shipper and the carrier stay the contracting parties, as the agent model requires, and both stay verified by Trucker. The broker can do only what each represented organisation has allowed, every action is shown as "done by the broker for that organisation", and the represented organisation can withdraw the mandate at any moment. The broker is paid **a share of Trucker's own fee** on bookings it handled, under its own agreement with Trucker, fixed on the booking at acceptance and paid only when Trucker's fee for that booking has been received. No hidden margin is allowed.

## 2. Why these principles

| Principle | Why it matters for Trucker |
|---|---|
| The broker is an organisation, verified like the others, with people as its members | Fits the model already built: people belong to organisations, organisations hold capabilities. A "broker" capability joins "ship" and "carry as company" |
| A broker acts only under a mandate from the organisation it represents | A shipper or carrier keeps control of what is done in its name. Nothing is done for an organisation that did not agree to it |
| The represented organisation must exist and be verified by Trucker, and must accept the mandate itself | A broker cannot invent shippers or carriers, or put unverified trucks on the platform. The same pattern as a driver accepting a carrier's invitation |
| Every action shows who did it and for whom (E-4 already requires this) | Disputes, audits and support can always tell the broker's actions from the organisation's own |
| The contract stays between shipper and carrier; the broker never becomes a party and never holds transport money | Keeps the agent model (D-001) and the rule that Trucker holds no transport money (DB-1). A broker who buys from carriers and resells to shippers is a different business: a principal |
| No hidden margin | If a broker quoted a shipper more than the carrier receives and kept the difference, quotations would stop being comparable, the shipper would not know the real price, and the broker would in effect become a principal |
| One broker per side of a booking, and not both sides of the same booking in the pilot | Representing both shipper and carrier on one deal is a conflict of interest that needs disclosure rules the advisers have not given yet |
| The broker sees only what its mandates cover | Data protection and trust: a broker for one shipper sees that shipper's shipments and quotations, not other organisations', and never driver documents |
| Commission is fixed on the booking at acceptance, in exact decimals, like the fee | No later change of rate alters a past booking; both the broker and Trucker can check every figure |
| Commission is earned only when Trucker is paid, and never on a cancelled booking | Trucker never pays out money it has not received, and there is no reason to push bookings that will not happen |

## 3. What a broker could do

| Acting for | Possible permissions in a mandate | Recommendation |
|---|---|---|
| A shipper | Prepare and publish shipments; read the quotations received; reject quotations; accept a quotation | Publish and read by default. **Accepting commits the shipper to a contract**, so it stays with the shipper's own administrator unless the mandate explicitly allows it, with a maximum amount per booking |
| A carrier | Read published shipments as the carrier would; prepare quotations; submit quotations | Read and prepare by default. **A submitted quotation is a binding offer**, so submitting needs explicit permission, with a maximum amount. Fleet, drivers, assignment and dispatch stay with the carrier |
| Either | See the bookings it handled, their state and its commission | Always, read-only, for as long as the records are kept |

A mandate has a start, an optional end, the permissions, the limits, and a record of who granted it. It is withdrawn by the represented organisation or the broker at any time, with immediate effect on new actions; bookings already made keep the broker recorded on them.

## 4. How the broker is paid

| Model | How it works | Assessment |
|---|---|---|
| **A. Share of Trucker's fee** | Each broker has an agreement with Trucker setting a share of Trucker's fee. On every booking the broker handled under a mandate, the share is fixed on the booking at acceptance and becomes payable when Trucker's fee for that booking is recorded as received | **Recommended for the pilot.** The shipper's price and the carrier's receipt are unchanged, quotations stay comparable, Trucker pays only from money it has received, and the rate is "based on how we deal with him", as you asked |
| B. Disclosed broker fee on the booking | The represented organisation agrees a broker fee in the mandate; it appears as its own line on the booking and is paid by that organisation directly to the broker | A possible later addition, after legal review: it matches how brokers earn today, but it raises the price the shipper sees, and the advisers must say whether Trucker may show and record it |
| C. Hidden margin | The broker adds to the carrier's price and keeps the difference | **Not allowed**, for the reasons in section 2 |

Practical rules for model A:

- The rate is set per broker in its agreement, versioned with a start date. A booking keeps the rate that applied at its acceptance.
- If the broker acted for both the shipper's side and the carrier's side through two different brokers, each earns its own share; the two shares together never exceed an agreed ceiling of Trucker's fee.
- Statements per month list each booking, its fee, the share and its state (expected, earned, paid, not earned). Payment is a recorded bank transfer, entered by one staff member and approved by another, like the rest of finance (DB-15).
- A share is not earned on a cancelled booking, and is withheld while the booking is in a dispute hold.

Whether a share of Trucker's fee is attractive enough to brokers who earn more today is not known. Ask two or three of them before setting the rate; if it is not enough, model B is the way to add income without a hidden margin.

## 5. Controls

| Risk | Control |
|---|---|
| A broker creates fake demand or fake carriers | Every represented organisation is verified by Trucker and accepts the mandate itself |
| A broker acts beyond what was allowed | Permissions and amount limits are checked by the database on every command, like every other rule |
| A shipper or carrier is cut out of its own business | It sees everything done in its name and can withdraw the mandate at once |
| A broker steers work to carriers it is paid by elsewhere | No dual representation in the pilot; the broker's agreement requires disclosure of any payment it takes from either side for the same booking |
| A broker sees too much | Access follows the mandate, ends with it for new data, and never includes driver documents or other organisations' quotations |
| Commission errors | Fixed on the booking at acceptance, exact decimals, two-person approval of payments, and a reconciliation report |
| A broker misbehaves | Staff can suspend the broker capability; existing bookings continue between shipper and carrier |

## 6. Where it fits in the plan

Release 1 is defined as the core journey with manual operations. A broker role touches publication, quotation, acceptance and finance, so it is best built once those are finished, as two focused slices: **B1** broker organisations and mandates (representation, permissions, on-behalf records), and **B2** broker agreements, commission on the booking, statements and payment records. B2 needs the finance records of slice 19.

If the pilot's carriers and shippers will mostly come through brokers, B1 can come straight after slice 18 so the pilot can use it; otherwise after slice 20.

**Not recommended as a stop-gap:** making a broker an administrator of each customer's organisation. Its actions would look like the customer's own, it would see everything, and no commission could be tracked.

## 7. Questions for advisers (not answered here)

- Does acting as a freight broker or transport agent need a licence or registration in the launch country, for the broker, for Trucker, or for both?
- May Trucker pay brokers a share of its fee, and how is that documented (contract, invoice from the broker, or self-billing by Trucker)?
- How is the commission taxed, for Trucker and for the broker?
- Does a broker need written authority from the organisation it represents under local law, and does the mandate in the platform satisfy that?
- What may a broker see of the organisations it represents under the data-protection rules, and for how long after a mandate ends?
- What must the broker agreement and the participant terms say about brokers?

## 8. Decisions needed (with recommendations)

| ID | Decision | Recommendation |
|---|---|---|
| BR-1 | Who a broker may represent | Shippers and carriers, but never both sides of the same booking in the pilot |
| BR-2 | What a mandate may allow | Section 3: publishing and preparing by default; accepting (for a shipper) and submitting a quotation (for a carrier) only with explicit permission and an amount limit |
| BR-3 | How the broker is paid | Model A, a share of Trucker's fee, under a per-broker agreement |
| BR-4 | The share | Set per broker after talking to a few brokers. Development default 25% of Trucker's fee, a placeholder with no market evidence behind it |
| BR-5 | When the share is earned and paid | Earned when Trucker's fee for the booking is recorded as received; not earned on cancellation; withheld during a dispute hold; monthly statement; paid by recorded bank transfer with two-person approval |
| BR-6 | Which bookings count | Only bookings where the broker acted under a mandate that was in force at acceptance, recorded on the booking. No permanent claim on a customer's later bookings |
| BR-7 | Verification of a broker | As a company, with registration evidence, plus any licence the advisers say is required |
| BR-8 | When to build | B1 and B2 after slice 20, or B1 after slice 18 if the pilot depends on brokers |
