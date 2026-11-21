# Trucker delivery status

## Native driver arrival estimate — 21 November 2026

After dispatch and before arrival, the driver can confirm a local arrival time computed
from remaining minutes. The app submits the UTC instant through the scoped driver API
and displays the latest saved estimate. Lint, TypeScript, 32 mobile tests, two trip
integration tests and both Metro exports passed. Native sending awaits a dispatched
Android demo trip.

## Local Android driver demo entry — 21 November 2026

The local-only sign-in screen offers a driver demo action that uses the existing fictional
participant and opens My trips. The Android emulator showed the fictional driver's assigned
trip from its active session. Fresh demo sign-in was not repeated to preserve that session.
Lint, TypeScript, 31 mobile tests and Android/iOS Metro exports passed.

## Native carrier quotation management — 21 November 2026

The selected company can list its quotations and withdraw a submitted offer with confirmation.
Withdrawal uses the carrier-scoped version and a stable retry key. The Arabic Android emulator
listed the demo carrier's accepted offers. Lint, TypeScript, 31 mobile tests, three API tests
and both Metro exports passed. The demo seed is still sign-in-rate-limited, so an open offer
was not available for a native withdrawal test.

## Native shipper quotation rejection — 21 November 2026

The customer may reject an open received quotation after confirmation. The screen sends
its current version and retains a retry key for the same action, and updates the record
only after the server confirms. TypeScript, lint, 30 mobile tests, two PostgreSQL
quotation tests and both Metro exports passed. Native rejection was not exercised on-device.

## Native shipper quotation acceptance — 21 November 2026

The shipper reviews received quotations, server-calculated booking amounts and freight
payment choices, and accepts with the current quotation version and a stable retry key.
The Arabic Android emulator accepted the fictional XTS offer. A read-only query confirmed
exactly one booking, an accepted offer and an awarded shipment. Lint, TypeScript, 29 mobile
tests, two authority tests and both Metro exports passed. The next open fixture is prepared
by the seed script, whose live rerun was rate-limited by local sign-in.

## Native quotation submission smoke — 21 November 2026

From the Arabic public board, the Android emulator submitted the matching carrier's
fictional 1250.50 XTS quotation on TRK-DEMO-OPEN. A read-only query against the
local-development database confirmed exactly one submitted quotation version for the
fixture shipment and carrier. The offer remains open for shipper acceptance testing.

## Native shipment quotation currency — 21 November 2026

A shipper can save a supported currency on a published shipment until quotations lock
the terms. The Android emulator saved XTS on the local fictional shipment and opened
the matching carrier quotation form from the public board using the existing session.
Lint, TypeScript, 28 mobile tests, two API tests and both Metro exports passed.

## Native carrier quotations — 21 November 2026

The public board opens a company-scoped quotation form only after the API reports a
matching fleet and quotation terms. Amounts stay decimal strings and the carrier confirms
any server-calculated commission and net. The Arabic Android emulator showed the fleet
mismatch refusal. Lint, TypeScript, 27 mobile tests, two API tests and both Metro exports
passed. The seeded open shipment still needs quotation terms in the running database,
because the fixture refresh was rate-limited by local sign-in. Native submission remains
to be tested on the emulator.

## Native shipment draft editing — 21 November 2026

Company draft details open the latest version for editing. Saving preserves private access
notes, packaging and equipment fields from the saved record. Stale versions require an explicit
reload. The Android emulator loaded and saved the existing fictional draft through the UI.
Lint, TypeScript, 26 mobile tests, three shipment API tests and both Metro exports passed.

## Local fee settlement and dispatch readiness demo — 21 November 2026

A separate fiction-only booking retains its own non-overlapping vehicle and driver window.
One fixture administrator records a simulated transfer and another approves it. A same-staff
approval is refused. The confirmed booking has a paid platform fee, an acknowledged assignment
and dispatch readiness. Dispatch before the permitted window is refused. The earlier test
bookings remain in awaiting_resources and awaiting_fee for comparison.

## Local assignment and driver acknowledgement demo — 21 November 2026

The local seed preserves the unassigned booking and adds a second shipment and booking.
The fixture driver joins the matching carrier, and truck and driver documents are reviewed
through the local test reviewer. The carrier assigns the truck and driver, and the demo
account acknowledges the assignment. The API verified both resources, the acknowledgement,
and the awaiting_fee booking state. No payment or dispatch was recorded.

## Local shipment-to-booking demo data — 21 November 2026

Run the guarded fixture command against the running localhost API and a database already
marked local-development. It uses the fictional mobile demo account and retains three
companies with a draft, live shipment, withdrawn shipment and accepted booking. The seed
checks that the carrier without a matching vehicle receives fleet_mismatch and that the
matching carrier can quote. The Arabic Android board rendered the live fictional shipment.

```powershell
$env:TRUCKER_LOCAL_FIXTURES='local-development-only'
node tools/dev/with-env.mjs node tools/dev/demo-scenarios.mjs
```

## Native shipment draft creation — 21 November 2026

The company shipment list creates a draft with cargo, configured countries/time zones,
private addresses and local pickup and delivery windows. It opens the saved record for
role assignment and publication. Lint, TypeScript, 25 mobile tests, four shipment API
tests and Android/iOS Metro export passed. Authenticated device creation remains open.

## Native startup and session recovery — 21 November 2026

Expired saved sessions are cleared and reported in the selected language. An unknown
restore failure remains distinguishable and retryable. On the Trucker Android emulator,
the Arabic public board, phone field and sign-in screen loaded without a stale unknown
message after relaunch. Lint, TypeScript, 23 mobile tests and four API session tests passed.
External code delivery was kept paused.

## Native shipment withdrawal — 21 November 2026

Mobile users can withdraw a published or suspended shipment after confirmation. The scoped
versioned command reuses its retry key and refreshes the card after confirmed withdrawal.
Lint, TypeScript, 23 mobile tests, three PostgreSQL checks and Android/iOS Metro export passed.

## Native draft publication — 21 November 2026

The mobile draft details load publication catalogues and submit selected cargo and equipment,
public areas, dangerous-goods declaration and the pickup-local quotation deadline. The
versioned command retains its retry key for the same input and refreshes local shipment status
after confirmation. The server validates permission and readiness at submission. Lint, TypeScript,
22 mobile tests, five PostgreSQL tests and Android/iOS Metro export passed.

## Native draft shipment roles — 21 November 2026

A broker can select an active customer authority on an existing draft and save the named
receiver, freight payer and platform fee payer. The change uses the scoped parties command
with the current draft version. The server checks publication authority and fee agreement.
Lint, TypeScript, 21 mobile tests, three PostgreSQL tests and Android/iOS Metro export passed.

## Native arranged shipment review — 21 November 2026

The authorities screen lists arranged shipments for the selected company and opens the
current quotation amounts and standings through the scoped read endpoint. The organiser
can review offers, and the customer retains acceptance authority. TypeScript, lint, 20 mobile
tests, two PostgreSQL authority tests and Android/iOS Metro export passed.

## Local completion review — 21 November 2026

1. Mobile broker and carrier contracts: proposals by account code, fixed or percentage
   terms, carrier decisions, withdrawal and ending now use the existing versioned API.
   Lint, TypeScript, 19 mobile tests, four contract integration tests and Android/iOS
   Metro export passed. The Android emulator opened the app but stopped at API origin
   configuration. Authenticated native journeys remain to be verified.
2. Board and dispatch-to-closure: six PostgreSQL checks passed for fleet gating, private
   photos, hold isolation and financial/operational closure. Two Chrome journeys passed
   for quotation and booking from the public board and for the mediated dispute.
3. Local services: API readiness, Arabic web with RTL and staff sign-in returned HTTP 200.
   External sign-in delivery remains paused. No production services were changed.
4. Remaining delivery: broker shipment management and authenticated native device QA
   still require implementation or verification. Photo sharing requires an explicit
   access policy from Abdullah. Release requires issuer and tax details from finance,
   provider and signing configuration from the operator, and release approval.
   See RELEASE_1_GAP_TO_LAUNCH.md for the external decision owners.

## Native customer authority decisions — 21 November 2026

Customers can review an incoming broker mandate, accept it with explicit publication and
fee permissions, decline it, or end an active mandate. The app submits the displayed version
and reloads the company authority list. TypeScript, 18 mobile tests, two authority integration
tests and Android and iOS Metro export passed. No physical device test was run.

## Native broker authority — 21 November 2026

The broker can list customer authorities, request one by customer account code, and end
active or pending authorities after confirmation. The company-scoped API owns permission
checks and validates the supplied version. Customer decisions still use the web. TypeScript,
17 mobile tests, one PostgreSQL authority test, and Android and iOS Metro export passed.

## Native fleet photos — 21 November 2026

The company view shows fleet for accounts with an effective company-carrier capability.
Vehicle cards reuse the private record photo picker, preview, list and retry-safe upload.
The API checks ownership and admin access. TypeScript, 16 mobile tests, one PostgreSQL
integration test and Android and iOS Metro export passed. No device was connected.

## Dispute and financial review navigation — 21 November 2026

The staff dispute queue uses record cards with links to the specific dispute. Booking
financial records link back to finance and to operational closure after a successful
record read. Console lint, build and all 362 Chrome checks passed. Local sign-in returned
HTTP 200 after the console restart.

## Staff console queues — 21 November 2026

Staff queues for shipments, bookings, fleet, verification, operations, staff accounts,
fees, refunds and finance use responsive cards. Operational closure records use the
shared action menu. The console passed 362 Chrome checks and returned HTTP 200 locally.

## Driver and incoming quotation lists — 21 November 2026

Driver assignments, fleet invitations and incoming quotations use responsive cards.
Invitation decisions and the quotation rejection action use the record menu. Driver
trip actions and the quotation acceptance/payment choice remain directly visible.
Web lint for both files, the production build and 24 unit tests passed.

## Responsive organisation record lists — 21 November 2026

Company, discovery, quotation, booking, fleet, authority, contract, cargo and financial
completion lists use responsive record cards. The operations workspace retains desktop
tables and mobile cards. Authority and contract actions use the shared record menu with
the existing permission checks and server actions. Web type checking, 24 unit tests and the full
Chrome suite passed. The local web container was rebuilt and returned HTTP 200.

## Organisation operations workspace — 21 November 2026

The web company page links to a Trucker operations workspace for shipments, dispatch and
bookings, and fleet. It uses the existing organisation-scoped reads and links to the authorised
record actions. Tables become labelled cards on phones. The Arabic Chrome journey rendered
both layouts, opened the booking options, and verified the booking detail link.

## Private shipment and vehicle photos — 21 November 2026

Migration 0040 adds private photos for company shipments and vehicles. The web exposes upload
and viewing for both, and the native app exposes shipment photo selection, preview and upload.
The API verifies company authority, records upload events and accepts a stable photo ID on
retry. Two PostgreSQL integration tests passed for ownership checks, upload and retry, and
the API and web restarted healthy locally. Carrier sharing and native fleet photos are open.

## Native evidence and broker accounts — 21 November 2026

Booking details can load disputes for the authorised account, preview a JPEG or PNG and upload
its bytes using the existing dispute evidence API and a retry key. Terminal disputes show their
closed state. Broker accounts can read their booking and quotation commissions in the same
native app as driver trips. A broker payee can confirm a reported commission payment after
checking its reference and explicitly confirming. The command uses the existing scoped payment
route, preserves its retry key, and does not move funds. Shipment and vehicle photos and the
remaining native broker management actions
remain open.

## Freight workspace update — 20 November 2026

Trucker uses a compact desktop shipment list with narrow-screen cards, informed by Uber Freight
shipment workflows and DAT load-board patterns. Company shipments and bookings have record
options that reuse existing permission-checked routes. The single native app identifies an
effective broker organisation from verification without changing the driver's trip access.
Selected photos can be previewed before existing POD upload. Cargo and vehicle photo storage
and the native broker's management commands remain to be implemented.

## Sign-in delivery paused — 20 November 2026

External sign-in code delivery remains disabled. The running local API uses
development-display for local testing only. The mobile app explains an unavailable
delivery service in English, Arabic and Urdu.

## Release verification — 20 November 2026

The isolated release checks cover shipment publication, quoting, booking acceptance, fleet
assignment, driver acknowledgement, fee payment and deduplication, dispatch, milestones,
delivery outcomes, POD, disputes, financial reconciliation and operational closure. Legacy
booking tests now supply a matching fleet fixture before expecting quotation success. Database
security checks still require an exact function allowlist and no direct access to protected
tables. The final API run passed 431 tests, with both opt-in Chrome journeys run separately.
The full web and console browser suites passed, as did web unit tests, development tools,
workspace type checks and lint. The finance console link meets the browser touch-target check.

The mobile sign-in screen now shows the server-provided retry wait and offers a fresh challenge
after an expired, replaced, locked or consumed code. Eight mobile client tests passed and the
Android and iOS JavaScript bundles exported. The Android emulator opened the trip list, but the local
demonstration account had no assigned trip. Driver dispatch and POD were exercised through
the isolated API rather than on a physical phone. Real sign-in delivery, production storage,
issuer and tax requirements, production signing and external release approvals remain open.

## Published shipments on home — 20 November 2026

The web and mobile home pages list all currently open published shipments through the paginated
public endpoint. The public cards contain only a shipment ID, countries, equipment and quotation
deadline. The quotation command independently requires a verified active fleet match, including
a matching trailer when the truck category requires one. The web quotation form explains a fleet
mismatch. Migration 0039 is required on the API database before using these screens.
Signed-in web users can open a shipment's quotation from its home card and choose a verified
carrier account. The chooser checks the scoped quotation context before displaying the form link.
An opt-in Chrome regression test on an isolated PostgreSQL database passed the Arabic journey:
without a matching truck the form link is hidden, and after adding one the carrier submits a quote.
The shipper accepted that quote from the Arabic web UI and opened the same booking recorded
by the API, with the agreed amount and awaiting-resources status.

## Mobile work — 20 November 2026

The native Trucker app now reads operational closure status and the authorised platform fee
invoice draft from the booking list. Mobile TypeScript, seven client tests and Android
Metro export passed. The signed Android debug APK was verified for ARM64 and x86_64. No physical device was used in this check.


## Local update — 19 November 2026

Shared web/console redesign and a new native mobile development app are in the uncommitted
branch `codex/unified-experience-mobile`; see `UX_REDESIGN_MOBILE_2026_11_19.md` and
`apps/mobile/README.md`. Web/console browser checks pass; installable mobile builds and
physical devices are not verified. No merge, push or deployment is recorded.

Slice 18c local work adds a booking dispute and mediation journey, private evidence and a
cause-specific settlement hold in migrations 0033 and 0034. See [the implementation record](DISPUTES_SLICE_18C.md)
for the development defaults and remaining policy and verification.
The historical branch/PR information below has not been reverified against GitHub.

Date: 17 November 2026. Replaces the status of 13 November 2026, which described the foundation stage.

## Approved direction

Trucker is a separate project from TruckLink, in `abdullahhouranii-ux/Trucker`; nothing is copied from TruckLink's implementation. The commercial model is recorded in `docs/specs/ADR_001_COMMERCIAL_MODEL.md`: Trucker acts as an agent and earns a separate fee, paid and verified before a booking is confirmed; an organiser's commission is included in the shipping price and paid by the carrier to the organiser.

## Built

Each slice has a scope and a record with its evidence in this folder.

| Slices | Content | Where |
|---|---|---|
| 1 to 10 | Foundation, web foundation, registration and sign-in, organisations, identity hardening, shipment drafts, staff identity, organisation verification, shipment publication | Merged into `staging` (not `main`) |
| 11 | Carrier onboarding and discovery | PR #15 |
| 12 | Quotations | PR #16 |
| SEC-01 | Security fix (release blocker until merged and `staging` is green) | PR #17 |
| — | Release 1 plan and readiness documents | PR #18 |
| 13 | Fleet and drivers | PR #19 |
| 14 | Acceptance and booking | PR #20 |
| 15 | Assignment, reservation and confirmation | PR #21 |
| 16 | Cancellation before dispatch | PR #22 |
| — | ADR-001 and the phase two scope (documents) | PR #23 |
| 21 | Individual accounts and truck owners | PR #24 |
| 22 | Shipment roles and authority | PR #25 |
| 23 | Organiser commission: percentage and fixed amount | PR #26 |
| 23b | Commission contracts accepted in advance | PR #27 |
| 24 | Financial settings: versions, second-administrator approval, effective time | PR #28 |
| 25 | Price breakdown, views by role, fee payer from roles, freight terms on each booking | PR #29 |
| 26 | Trucker's fee before confirmation: bank transfer verified by two administrators, lapse at the deadline, refund records | PR #30 |
| 27 | Online payment of the fee through a provider-neutral interface (development stand-in only), receipts; corrected after the independent review of 17 November 2026 (R2 to R5) | PR #31 |
| 28 | Refunds of the fee (requested, approved, submitted, completed or failed; partial; never more than the payment) and reconciliation, by independent staff; no real provider, no money moves | PR #32 |
| 17a | Dispatch (one step, refused with the first failing precondition, idempotent) and the trip's milestones by the driver or on the driver's behalf, the arrival estimate, and what each party sees; exceptions (17b) not built | PR #33 |
| 17b | Exceptions reported by the driver, carrier or shipper; the operations privilege, queue and cases; overrun and missing-arrival cases; dispatch blocks, trip holds, operations' milestones and withdrawing a mistaken one | PR #34 |
| 18a | Delivery outcome (by the driver, or on behalf), operations case for anything but full delivery, cargo custody and handover, release of each resource on the release condition | PR #35 |
| 18d | Undeliverable, refused and partly delivered cargo (R-406): authority to instruct, instructions and costs, approval within limits, escalation and the emergency plan, confirmed handovers, further legs of the trip, claims and holds by cause | PR #36 |
| — | Node.js 24 and npm 11 | PR #37 |
| 18b | Proof of delivery: manifest, files checked by fingerprint behind a storage interface (development stand-in only), review by the shipper only, never by silence | PR #38 (planned number) |

Pull requests #15 to #32 are stacked, open and green in CI; slice 17a's pull request is open. None is merged; each needs a dependency review and Abdullah's explicit authorisation.

## Next

1. Phase five (dispatch, proof of delivery, settlement, closure), each as its own unmerged pull request, on development defaults, under the instruction of 17 November 2026 (11:46).
2. Slice 18c is implemented locally. The manual release rule is recorded in [the slice record](DISPUTES_SLICE_18C.md). On 20 November the isolated review patch applied to 9deb039, typechecked across API, web and console, built the API and passed both 18c API integration tests on isolated PostgreSQL. The browser scenario was skipped in that run. Abdullah approved explicit settlement of counterclaims on 20 November 2026. Migration 0035 requires both parties to accept a proposal that records settlement terms for counterclaims and follows the latest recorded counterclaim before their dispute hold can be manually released. Final local verification passed 23 focused tests across disputes, POD and cargo, including the Chrome counterclaim journey, and all three builds. The refreshed review patch applied to a clean copy of 9deb039.
3. Slice 19 is implemented locally for external freight and commission records, independent reconciliation, and hold-aware eligibility (migration 0036). Abdullah confirmed immediate platform fee invoicing after confirmed payment, delivery to the booker, tax added where applicable, exceptional refunds only, and carrier-issued freight invoices. Migration 0038 prepares one internal invoice draft at settled fee payment, visible to the payer organisation and finance staff, with a staff-only 5% illustration for OMR. The API build, all workspace type checks, 22 payment/refund tests and the 19/20 integration passed on isolated PostgreSQL. Live tax issuance and delivery, accounting details, refund exception criteria, organiser commission invoicing, and original-evidence retention remain open.
4. Slice 20 is implemented locally for eligible dispatched bookings (migration 0037). It uses the financial result from slice 19, checks POD and releases, and records closure once. The operations queue shows blockers and follow-up ownership. The three builds and 30 local checks passed across the covered journeys, including Chrome. The 19/20 review patch also applied after the 18c patch to a clean 9deb039 snapshot, then passed typechecking across all three workspaces, the API build and three isolated PostgreSQL integration tests. See [the implementation record](FINANCIAL_COMPLETION_AND_CLOSURE.md).

## Open decisions

- ADR-001: defaults D-1 to D-12 and open decisions O-1 to O-7, including merging #15 to #22 (O-6).
- Dispatch: DD-1 to DD-10 (`DISPATCH_SLICE_17_SCOPE.md`).
- Launch country and lanes; suppliers (hosting, sign-in messages, file storage, payment provider).
- Adviser questions: ADR-001 section 8 and the external blockers in `RELEASE_1_GAP_TO_LAUNCH.md`.

## Not claimed

No production deployment. No real participant data. All commercial values are development defaults. No physical-phone, screen-reader or native Arabic and Urdu review has been done; those are in `FINAL_AUDIT_BACKLOG.md`.
