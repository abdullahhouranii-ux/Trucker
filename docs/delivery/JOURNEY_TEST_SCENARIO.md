# Full journey test scenario (local, by hand)

For Abdullah, 22 November 2026. This is a test you run by hand on your PC, from the pilot invitation to the closure of a booking. Everything is fictional: the organisations, the people, the documents, and the currency (XTS). The mobile numbers start with +999, which belongs to no country. No message, payment or file leaves your PC.

The demo data comes from `npm run dev:demo:journey` (`tools/dev/journey-demo.mjs`). It prepares the people, the two verified organisations, the truck, the driver and the pilot invitations, so that you start at the business journey rather than at the paperwork.

**Before you rely on it:** I ran the same journey end to end through the API with `npm run dev:demo:journey -- --run`, on a fresh local database with the pilot rule switched on, and the booking closed (22 November 2026, 14:19 Oman time). I did not click through these exact steps in a browser. The screens themselves are covered by the web and console browser suites. If a label differs from what you see, note it in the results table at the end.

## Who is who

| Role | Signs in with | Where | Organisation |
|---|---|---|---|
| Shipper (Sara) | +999500000101 | Trucker, http://localhost:3100 | Demo Shipper LLC (fictional) |
| Carrier (Khalid) | +999500000102 | Trucker | Demo Carrier LLC (fictional) |
| Driver (Omar) | +999500000103 | Trucker (on a phone-sized window, if you like) | drives for Demo Carrier LLC |
| Invited contact (Layla) | +999500000104 | Trucker | invited, not yet registered |
| Not invited | +999500000105 | Trucker | nobody |
| Staff administrator A | the e-mail you bootstrap | Console, http://localhost:3200 | holds staff administrator, reviewer and operations |
| Staff administrator B | a second e-mail | Console | staff administrator |
| Staff administrator C | a third e-mail | Console | staff administrator |

On this local setup the one-time code is shown on the screen after "Send the code". You do not need a phone for participants.

Three staff administrators are needed because Trucker never lets one person check their own work: B approves the fee that A recorded, B reconciles the freight that A reviewed, and C reconciles the fee, because A and B already had a hand in it. Each staff member needs an authenticator app entry (Google or Microsoft Authenticator). Use a separate browser profile, or a private window, for each staff member and each participant, so their sessions do not mix.

Times: country XA in the demo is UTC+4, the same as Muscat, so XA local time is your clock. Country XB is UTC+3.

## Part 0. Prepare the PC (once, about 15 minutes)

In PowerShell, in `C:\Users\Trustds\source\Trucker`. This uses only the Trucker Docker database. It does not touch Odoo or the PostgreSQL_For_Odoo service.

```powershell
git fetch origin
git checkout feat/journey-demo
git pull
npm ci
npm run dev:db:reset
npm run dev:migrate
npm run dev:app-role
$env:TRUCKER_LOCAL_FIXTURES = 'local-development-only'
npm run dev:fixtures
```

`dev:app-role` prints an `APP_DATABASE_URL` line: check that it matches the one in your `.env`.

Start the three applications, in the way `WINDOWS_SETUP.md` describes ("Run Trucker in the background with Docker Desktop"), or in three PowerShell windows:

```powershell
npm run dev:api
```

Then, with the API running, load the demo data:

```powershell
$env:TRUCKER_LOCAL_FIXTURES = 'local-development-only'
npm run dev:demo:journey
```

It ends with "Ready" and the list of numbers above. It can be run again safely: it makes nothing twice.

Switch the pilot rule on, so that only invited numbers can register:

```powershell
npm run dev:settings -- set pilot_invitation_required=1
```

## Part 1. Staff accounts (about 10 minutes)

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 1.1 | You | PowerShell | `npm run dev:staff:bootstrap -- a@example.test "Admin A"` | A single-use enrolment link is printed |
| 1.2 | A | The link, in browser profile A | Set a password, scan the key into your authenticator, enter the code | Recovery codes are shown. Keep them for the test |
| 1.3 | A | Console → Staff accounts | Create an account for `b@example.test` ("Admin B"), declaring no participant account | An enrolment link is shown |
| 1.4 | B | That link, in browser profile B | Enrol as in 1.2 | B is signed in |
| 1.5 | A | Staff accounts | Grant B the staff administrator privilege. Try to grant yourself anything | B's change is confirmed. Your own account offers no change: "Another staff administrator must make any change to your account" |
| 1.6 | B | Staff accounts | Grant A: reviewer and operations | Confirmed |
| 1.7 | A | Staff accounts | Create C (`c@example.test`); grant C staff administrator; C enrols in profile C | C is signed in |

## Part 2. The pilot invitation (about 10 minutes)

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 2.1 | A | Console → Pilot invitations | Read the top line | "Registration needs an invitation…". The demo's invitations are listed: Sara and Khalid as Registered, Layla as Open |
| 2.2 | Not invited | Trucker → Sign in | Enter +999500000105, send the code, enter it, then fill in Finish registration | Refused: "Registration is by invitation during the pilot, and this number has no open invitation…". Switch the language to Arabic and Urdu and try again: the same message in each |
| 2.3 | A | Pilot invitations | Invite +999500000105, organisation "Test Org (fictional)", name "Test Person" | "The invitation was recorded. Nothing was sent…". It is listed as Open |
| 2.4 | Not invited | Trucker | Finish registration again | Registered. On the console, the invitation now shows Registered |
| 2.5 | A | Pilot invitations | Invite +999500000105 again | Refused: "Someone has already registered with this number" |
| 2.6 | A | Pilot invitations | Cancel Layla's open invitation | Moves to "Taken, cancelled and expired" as Cancelled |
| 2.7 | Layla | Trucker | Sign in with +999500000104 and try to finish registration | Refused, as in 2.2 |
| 2.8 | A | Pilot invitations | Invite +999500000104 again; Layla registers | Registered |
| 2.9 | A (optional) | Console → Audit | Look at the latest entries | The invitations and cancellation are recorded, without the numbers or names |

## Part 3. The journey (about 45 minutes)

Do Part 3 in one sitting. The pick-up must start at least 8 hours after you publish, so dispatch is allowed at once (dispatch opens 12 hours before pick-up), while assigning is still allowed (it closes 6 hours before pick-up).

### 3A. Shipment and quotation

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 3.1 | Sara | Trucker → Demo Shipper LLC → Shipments → New shipment draft | Reference `TEST-1`; cargo "Packed tiles, 24 pallets"; 12000 kg; 24 pieces. Pick-up in XA (time zone UTC+4), address and access notes of your choice, **from now + 8 h to now + 10 h**. Delivery in XB (UTC+3), **from now + 14 h to now + 18 h**, in XB time. Save the draft | "The changes were saved. The server confirmed it." |
| 3.2 | Sara | The draft → Publish | General dry cargo, curtain-side, no dangerous goods; pick-up area and delivery area; quotation deadline **now + 4 h**. Publish the shipment | "The shipment was published." The access notes and full addresses are not in "What carriers would see" |
| 3.3 | Sara | The shipment → Quotations → Currency and inclusions | Currency XTS. Save | Saved |
| 3.4 | Anyone (signed out) | http://localhost:3100 → Published shipments | Look at the public board | TEST-1 is listed with countries, equipment and deadline only: no addresses, no company names |
| 3.5 | Khalid | Trucker → Demo Carrier LLC → Find shipments | Open TEST-1 | The pick-up and delivery areas are shown, not the addresses |
| 3.6 | Khalid | Send a quotation | 1250.50 XTS; valid until **now + 3 h**; earliest pick-up **now + 8 h 30 min**; tick the first inclusion. Send the quotation | "Your quotation was sent." |
| 3.7 | Sara | The shipment → Quotations received | Open Khalid's quotation; read "If you accept this quotation"; Accept this quotation | A booking: freight 1250.50 XTS, Trucker's fee 37.52 XTS (development default 3%), status waiting for the fee and resources |

### 3B. Trucker's fee (bank transfer, two administrators)

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 3.8 | A | Console → Fee payments → Fees due | Find the booking's fee and its reference. In "Record a transfer from the bank statement" enter that reference, 37.52, XTS, today's date and a statement line such as `STMT-TEST-1` | It moves to "Waiting for a second administrator" |
| 3.9 | A | The same entry | Try to approve it yourself | Refused: a different administrator must approve |
| 3.10 | B | Fee payments → Waiting for a second administrator | Approve | Approved. On Sara's booking page the fee shows as paid |

### 3C. Resources, dispatch and the trip

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 3.11 | Khalid | Trucker → Bookings → the booking → Assign your resources | Truck JRNY101 and driver Omar; no trailer. Save the assignment | "The booking is confirmed." |
| 3.12 | Sara | Her booking page | Look at Resources | The truck's plate and the driver's name are shown, not the driver's phone or documents |
| 3.13 | Omar | Trucker → Driver → Your assignments | Acknowledge this assignment | "You acknowledged this assignment." Omar sees the pick-up and delivery details he needs for the trip |
| 3.14 | Khalid | The booking → Trip | Dispatch | "The booking is dispatched. The trip has started." |
| 3.15 | Omar | Your assignments → the trip | Record, one at a time: Left for pick-up, Arrived at pick-up, Loading started, Loaded and left, Arrived at delivery | Each is listed with its time. Sara sees the same milestones on her booking page |
| 3.16 | Omar (optional) | The trip | Try to record a milestone out of order | "That is not the next milestone. Nothing was recorded." |

### 3D. Delivery and proof of delivery

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 3.17 | Omar | The trip → Record the delivery outcome | Delivered in full; receiver's name "Receiver Test". Record the outcome | Delivery recorded |
| 3.18 | Omar | Send the proof of delivery | Add the receiver's signature and a photo of the cargo: any JPEG or PNG pictures from your PC, under 10 MB. Send | "The proof of delivery was sent." The state becomes "received: waiting for the shipper's review" |
| 3.19 | Sara | Booking → Proof of delivery → Review the proof of delivery | Open the files; Accept | "The proof of delivery is accepted." |
| 3.20 | Khalid | Booking → Release resources | Release the truck, then the driver | Both released |

### 3E. Freight payment and closure

| # | Who | Where | Do | Expect |
|---|---|---|---|---|
| 3.21 | Sara | Booking → Financial completion → Freight payment | Record external payment: 1250.50 XTS; payment reference `BANK-TEST-1`; evidence reference `RECEIPT-TEST-1` | Listed as Reported |
| 3.22 | Sara | The same record | Try to confirm the receipt | Not offered or refused: only the receiving side confirms |
| 3.23 | Khalid | Booking → Financial completion | Confirm receipt | Receipt confirmed |
| 3.24 | A | Console → Finance → Booking financial records | Paste the booking identifier (the last part of the booking page's address) → Find booking. On the freight payment: Record first review, with a note | Reviewed. A cannot also reconcile it: "An independent administrator must reconcile this review." |
| 3.25 | B | Booking financial records, same booking | Reconcile against evidence: 1250.50 XTS; statement line `STMT-TEST-2`; evidence reference `STATEMENT-PAGE-1` | Reconciled |
| 3.26 | C | Console → Refunds → To reconcile | Reconcile Trucker's fee payment of 37.52 XTS against the bank statement, with a statement reference | "Recorded: the statement or report matches." (A and B are refused here: they had a hand in the fee) |
| 3.27 | Sara | Booking page → Operational closure | Wait up to a minute and reload | **Closed.** The API closes the booking by itself once the POD is accepted, the resources are released, freight and fee are reconciled, and no hold is active |
| 3.28 | A | Console → Operations → the booking | Look at Operational closure | Closed, with nothing blocking |

## Part 4. Optional checks

| # | Check | Expect |
|---|---|---|
| 4.1 | In 3.25, B first enters a different amount, such as 1200 | Recorded as a discrepancy, and the booking does not close until A reviews again and B reconciles the right amount |
| 4.2 | Before 3.21, Sara opens a dispute about the freight amount on the booking | The booking cannot close while the dispute's hold is active. Withdraw the dispute, then A releases the hold in the console with a reason |
| 4.3 | Sign in as the driver on a phone, or in a 390-pixel-wide window, in Arabic | The trip page reads right to left, and every button is reachable by keyboard |
| 4.4 | Run `npm run dev:demo:journey -- --run` | The same journey runs through the API in about two minutes and ends with "Journey complete … is closed". It leaves a second, closed booking in the demo data |

## Afterwards

To switch the pilot rule off again: `npm run dev:settings -- set pilot_invitation_required=0`. To start over: run Part 0 again from `npm run dev:db:reset`.

## Results

Copy this table and fill it in. Note any step where the screen or wording differs from this document, even if it worked.

| Part / step | Passed? | What you saw, if different |
|---|---|---|
| 1 Staff accounts | | |
| 2 Pilot invitation | | |
| 3A Shipment and quotation | | |
| 3B Fee | | |
| 3C Resources, dispatch, trip | | |
| 3D Delivery and POD | | |
| 3E Freight and closure | | |
| 4 Optional checks | | |
