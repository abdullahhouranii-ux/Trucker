# Trucker: shipment roles and authority, slice 22, scope and acceptance criteria

Version 0.1, 17 November 2026. Status: **for approval. Nothing here is built.** Second slice of phase two (`ACCOUNTS_PHASE_2_SCOPE.md`). Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md`, not reopened here. Sources are marked as in the phase two scope: **Abdullah**, **Plan**, **Default** (development only).

## 1. What this slice is

An organiser (coordinator or broker) arranges a shipment **for a customer who has given it authority**. The shipment belongs to the customer's account, so the customer sees everything done in its name and existing isolation is unchanged. Every shipment records its six roles. No commission exists yet (slice 23) and no price or payment rule changes.

After this slice: a customer grants an organiser authority; the organiser creates and publishes the customer's shipment and reads its quotations; the customer accepts a quotation as today; every action shows who did it and for whom; the customer withdraws the authority at any time.

## 2. Rules

| ID | Rule | Source |
|---|---|---|
| S-1 | Each shipment separately identifies its organiser, sender, receiver, contracting customer, freight payer and Trucker-fee payer | Plan (R-2) |
| S-2 | A coordinator or broker manages only its own shipments or those it is explicitly authorised for | Plan (R-4) |
| S-3 | Data isolation is preserved | Plan (R-3) |
| S-4 | Operational details go only to authorised parties at the approved stage; site contacts are never invented, and none is collected here | Abdullah, 15 November 2026 |
| S-5 | A report or action made for someone else shows who it is for, who made it and under what authority, everywhere it appears | Abdullah (E-4) |
| S-6 | **Authority** is a record from the customer's account to one organiser: permissions, start, optional end. The organiser asks, naming the customer by the account code shown on the customer's account page; the customer's administrator accepts and chooses the permissions. Either side ends it at once. Ending it stops new actions; what was already done stays, with the organiser recorded on it | Default (design; ADR G-4, D-12) |
| S-7 | Permissions in this slice: create and edit drafts; publish, change and withdraw; read the quotations received. **Accepting a quotation stays with the customer** (S22-2) | Default |
| S-8 | A shipment an organiser creates under authority is owned by the customer's account. The contracting customer is that account. The organiser is recorded on the shipment and on every history entry it causes | Default (design) |
| S-9 | Roles: the **contracting customer** and the **fee payer** are verified Trucker accounts. The **sender** and **receiver** are each a Trucker account or a named party without one (a name only). The **freight payer** is the contracting customer, the sender or the receiver, so a receiver paying cash on delivery needs no account | Default (S22-1) |
| S-10 | A shipment created the present way (by a shipper for itself) gets its roles filled automatically: organiser none, customer and both payers the shipper, sender the shipper, receiver a named party. Existing shipments are filled the same way by the migration | Default (design) |
| S-11 | Roles are fixed when the shipment is published and copied into the booking snapshot at acceptance. A sender or receiver with an account gets no access to the shipment in this slice; what they see and do arrives with proof of delivery (slice 18) | Default |
| S-12 | An organiser never quotes on a shipment it organises, whichever account owns it | Abdullah (P2-2) |

## 3. Acceptance criteria

| ID | Criterion |
|---|---|
| SR-1 | An organiser requests authority by account code; nothing is granted until the customer's administrator accepts. A wrong code answers as for a record that does not exist and reveals nothing about any account |
| SR-2 | With authority, the organiser creates, edits, publishes, changes and withdraws the customer's shipments and reads their quotations. Each permission, removed on its own, refuses exactly its actions |
| SR-3 | Without authority, or after it is ended or has lapsed, every such action answers as for a record that does not exist. Ending the authority while a command waits leaves that command refused |
| SR-4 | The organiser cannot accept a quotation, cancel a booking, or read anything of the customer's account outside its shipments and their quotations |
| SR-5 | The customer sees every shipment made in its name, with who made each change. History entries carry the organiser, the customer and the authority |
| SR-6 | Every published shipment has all six roles; publishing without them is refused by field. The fee payer and contracting customer must be verified accounts; the freight payer must be one of customer, sender or receiver |
| SR-7 | The booking snapshot holds the six roles as they were at acceptance; later changes to any account do not alter it |
| SR-8 | An organiser that is also a carrier cannot discover or quote on a shipment it organises; another carrier can |
| SR-9 | Carriers see no more than today: the roles are not shown to carriers before acceptance, and after acceptance only what the staged-release rules already give |
| SR-10 | Isolation: an organiser with authority from one customer reads nothing of another; the closed-table and no-public-function checks cover every new table and function |
| SR-11 | Existing shipments, quotations and bookings keep working; their roles are filled by the forward-only migration. English, Arabic and Urdu; retries change nothing twice |

## 4. Out of this slice

Commission options and the carrier's acceptance of them (slice 23); the price breakdown and financial settings (phase three); fee and freight payment (phase four); accepting on a customer's behalf; what a receiver sees and does (slice 18); site contacts.

## 5. Decisions that block this slice

| ID | Decision | Recommendation |
|---|---|---|
| S22-1 | Which roles need a Trucker account | Contracting customer and fee payer must; sender and receiver may be named parties; the freight payer is one of customer, sender or receiver (S-9) |
| S22-2 | May an organiser accept a quotation for the customer | **Not in this slice.** Acceptance makes the contract and starts the fee, so it stays with the customer until payments exist. It can be added later as a permission with an amount limit |
| S22-3 | Who may be the fee payer | The contracting customer, or the organiser when the organiser chooses to pay. No one else |
