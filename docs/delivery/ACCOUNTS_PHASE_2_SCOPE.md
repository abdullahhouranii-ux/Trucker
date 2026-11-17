# Trucker: phase two (accounts, permissions and commission agreements), scope and acceptance criteria

Version 1.0, 17 November 2026. Status: **slice 21 approved by Abdullah on 17 November 2026, with P2-1 and P2-2 as recommended; built on `feat/individual-accounts` (record: INDIVIDUAL_ACCOUNTS_SLICE_21.md). Slices 22 and 23 are not yet scoped.** Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3), which this scope does not reopen.

## How to read the source of each rule

| Mark | Meaning |
|---|---|
| **Abdullah** | Stated by Abdullah in his own instructions (date given) |
| **Plan** | A recommendation in the Word plan "Trucker development plan for partners", adopted as the confirmed model by Abdullah's instructions of 17 November 2026. Not reopened here |
| **Default** | My proposal. Development only: fictional data, protected settings, and the production gate refuses to start on unapproved values. Never a production policy |

## 1. Phase two in three slices

| Slice | Content | State |
|---|---|---|
| **21. Individual accounts and truck owners** | Personal accounts; the coordinator, broker and truck-owner capabilities; a truck owner working the existing journey as a carrier | **Proposed now**: sections 2 to 5 |
| 22. Shipment roles and authority | The six roles on each shipment; authority to manage another party's shipments | Scope follows after slice 21 is approved |
| 23. Commission agreements | Percentage, fixed amount or contract on a request; the carrier's acceptance | Scope follows; its amounts land with phase three pricing |

Slice 21 is the smallest complete step: after it, a truck owner can register, be verified, quote, be accepted, assign their own truck and themselves, and reach a confirmed booking, using the journey already built. Slices 22 and 23 need it and do not change it.

Dispatch and proof of delivery (slices 17 and 18) stay a parallel workstream, waiting only for DD-1 to DD-10.

## 2. Slice 21: rules

| ID | Rule | Source |
|---|---|---|
| A-1 | A coordinator is a registered individual; a broker is a business; a truck owner offers an eligible vehicle and may also be its driver | Plan |
| A-2 | Data isolation is preserved for every new account type | Plan |
| A-3 | A commission never applies to a carrier that has not accepted it (enforced in slice 23; nothing in slice 21 creates a commission) | Plan |
| A-4 | Brokers earn commissions and get their own kind of account to manage their activity | Abdullah, 15 November 2026 |
| A-5 | Operational details are revealed only to authorised parties at the approved stage; site contacts never invented | Abdullah, 15 November 2026 |
| A-6 | An individual holds a **personal account**: an organisation record of kind `individual` with exactly one member, who is its administrator and cannot add members. One personal account per person. The person may also belong to companies | Default (design) |
| A-7 | Two new capabilities, applied for and verified by staff like the existing ones: `organise` (personal account for a coordinator, company for a broker) and `carry_as_owner_operator` (personal account only) | Default (design) |
| A-8 | Verification of an individual uses fictional evidence types in development. Real identity evidence and its retention rules come from the advisers before production | Default |
| A-9 | A truck owner becomes the driver of their own account by a recorded act, without an invitation. The one-active-affiliation rule holds: a person driving for a company cannot also drive for their own account, and the reverse | Default (design, follows DB-5's surviving half) |
| A-10 | Vehicles, documents, eligibility, discovery, quotation, assignment, acknowledgement and cancellation work for a truck owner exactly as for a company carrier. No rule is relaxed | Default (design) |
| A-11 | In slice 21 the `organise` capability lets its holder create and publish **its own** shipments, as a shipper does today. Acting for others is slice 22 | Plan ("their own or explicitly authorised shipments"); the split is design |

## 3. Slice 21: acceptance criteria

| ID | Criterion |
|---|---|
| IA-1 | A signed-in person creates one personal account. A second attempt is refused. Any attempt to add a member to it is refused by the database |
| IA-2 | A personal account applies for `organise` or `carry_as_owner_operator`; a company applies for `organise`. A company applying for `carry_as_owner_operator`, or a personal account for `carry_as_company`, is refused |
| IA-3 | A capability counts only after staff verification, with the same review, changes-requested, suspension and history behaviour as today. Suspended means no new shipments, quotations or assignments, and existing bookings are not cancelled |
| IA-4 | A verified truck owner registers a truck (and trailer), submits its documents, becomes its own driver, and is eligible only when the same vehicle and driver checks pass that apply to a company |
| IA-5 | The full journey passes with a truck owner as carrier: discover, quote, be accepted, assign own truck and self, acknowledge, confirmed. Cancellation before dispatch works |
| IA-6 | A person with an active company affiliation cannot become their own driver, and a self-driver cannot accept a company's invitation, until the other affiliation ends. Two simultaneous attempts leave exactly one active |
| IA-7 | Isolation: no other account reads a personal account's vehicles, documents, quotations or bookings; a personal account reads nothing of others beyond what a company in its position reads today. The existing closed-table and no-public-function checks cover every new table and function |
| IA-8 | A shipper comparing quotations sees whether the carrier is a company or a truck owner, and nothing personal beyond the name shown today for a carrier |
| IA-9 | Staff console: applications from individuals are reviewed in the existing queue, marked by account kind; every decision is audited |
| IA-10 | English, Arabic and Urdu; lost answers and retries change nothing twice; forward-only migration; existing accounts, quotations and bookings unchanged |
| IA-11 | Fictional evidence only. Production cannot start while individual evidence types are the development ones |

## 4. Out of slice 21

Shipment roles and authority (slice 22); commission options and contracts (slice 23); price breakdown and financial settings (phase three); fee payment, freight payment method and confirmation (phase four); any real identity document; converting a personal account into a company.

## 5. Decisions that block slice 21

Only these two. Everything else has a development default above.

| ID | Decision | Recommendation |
|---|---|---|
| P2-1 | How much may a truck-owner account hold? | **One truck, one trailer, and the owner as the only driver.** Anyone with more registers as a transport company. It keeps "truck owner" meaning what the plan says, and avoids an unverified small fleet |
| P2-2 | May one personal account be both coordinator and truck owner? | **Yes, but it can never quote on a shipment it organises** (enforced when slice 22 adds the organiser role). Refusing both would make people open two identities |

## 6. Recorded for later phases (not part of slice 21)

| Rule | Source | Where it lands |
|---|---|---|
| Freight is paid by **cash on delivery, bank transfer, or the carrier's activated card gateway**; the method and the due date are fixed on each booking | Abdullah, 17 November 2026 | ADR-001 R-26; booking snapshot in phase three, records in phases four and five |
