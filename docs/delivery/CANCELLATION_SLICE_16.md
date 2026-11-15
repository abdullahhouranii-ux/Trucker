# Cancellation before dispatch: slice 16

Date: 15 November 2026. Branch: `codex/cancellation`, based on assignment PR #21 at `d49e12049a20f2771193e4251b88faa8099dbaa2`. Local changes only; no commit, push, merge or deployment. Trucker is independent from TruckLink.

## Delivered journey

Either booking party's administrator cancels before dispatch, with a party-appropriate reason and a note required for `other`. The displayed assignment version prevents cancelling an assignment that changed unnoticed. A stale version returns a conflict and requires a deliberate retry. Once cancelled, any authenticated party retry returns the first record without duplicating or changing it.

The transaction locks both organisations, the shipment, the common assignment-state row and the resources, then reads the database clock and checks the session again. It records cancellation facts, releases active reservations including substitute holds, ends active assignments and proposals, invalidates acknowledgement through the assignment version, updates the shipment, and records one event for each party. The accepted booking and confirmation snapshots remain immutable. No charge, refund, compensation, invoice or tax is calculated.

Any occupancy episode, including a closed episode, blocks this pre-dispatch cancellation. Dispatch is not implemented: slice 17 must acquire the same assignment-state lock and record its boundary atomically. The existing consistency checker detects active assignments, reservations or proposals left on a cancelled booking.

Participant pages support English, Arabic and Urdu. Each party sees who cancelled, the reason and time. Only the cancelling organisation and authorised staff can read the note. The cancellation draft is scoped to organisation and booking. A lost response is reported as unconfirmed and can be retried; the subsequent database-backed view shows the cancellation actually recorded.

Staff can read a historical booking by booking identifier, with an audited reviewer/administrator check. The read-only console page remains available after a new booking is made for the same shipment.

## Publication cycles

A protected immutable mapping binds each booking to its publication cycle. The old one-booking-per-shipment restriction becomes one booking per cycle. Republish creates a new cycle, leaves old quotations closed, and allows a new quotation and booking while retaining the cancelled booking. Booking-created audit uniqueness remains per booking; shipment-awarded audit uniqueness is per shipment and cycle. The acceptance integration test covers the entire accept, cancel, republish, accept loop.

## Late assignment correction

Forward migration `0016_late_assignment_wait.sql` enforces the already-approved explicit wait decision after the initial assignment deadline. A later assignment cannot bypass that choice. Previously confirmed bookings are not invalidated by this initial-assignment deadline. Migration `0017_booking_cancellation.sql` adds cancellation and replaces affected functions forward-only; no merged migration was edited.

## Local verification

- PostgreSQL 16.14, portable Node 22.23.4 and npm 10.9.9 on Windows. An isolated cluster listens on 127.0.0.1:55439; no Odoo data or service was accessed.
- Affected API files (assignment, booking, identity hardening and organisation): 103 passed before the final extra race test. Final assignment file: 19 passed, including cancellation racing assignment, acknowledgement and substitution, expiry after a lock wait, resource reuse, private-note isolation and publication-cycle reuse. Together these cover 104 current affected tests.
- Message catalogue tests: 8 passed. Existing Windows helper tests: 9 passed during takeover.
- API, web and console TypeScript checks passed; participant and staff production builds passed. Targeted ESLint passed. Migration-file check: 17 valid.
- Staff-console browser suite: 243 passed. This is the existing console regression suite; the new historical-booking page is covered by its production build and authorised/unauthorised API tests, not a dedicated browser journey.
- Participant-browser suite: 1,982 passed, including lost cancellation response, idempotent confirmation retry, cancelled booking in EN/AR/UR and note isolation. The first run had two failures because the new lost response contaminated the later session-test counter; after resetting the counter, the complete rerun passed.
- Final form retention correction: enable the existing DraftKeeper overwrite option so a saved reason restores over the select's default. Rebuilt the web app, then ran a focused browser check against the real local API and database: reason and note survived reload/language changes in EN, AR and UR (6 assertions). The full suite predates that one-prop correction; the focused check covers it. No cancellation was submitted by the focused check.

## Failures corrected during verification

The second acceptance in the publication-cycle test initially exposed the old shipment-awarded audit unique index. The index is now scoped to the publication cycle and the full loop passes. A permissions test assumed the migration login was literally named `trucker`; it now obtains and quotes the real owner login, preserving the privilege-escalation assertion. Adding a lost cancellation answer exposed the browser helper's shared lost-response counter; it is reset after that journey before the existing session checks.

## Limits and next step

The local dependency install used separate packages because this environment refused workspace symlink creation. Manifests and the committed lockfile are unchanged; a clean locked workspace install and GitHub CI remain required before merge. Docker was not run. No physical-phone, screen-reader or native-reader review was performed. Arabic/Urdu wording and cosmetic corrections are deferred in the final-audit backlog.

Production gates and real commercial/legal settings remain unchanged. No live cancellation policy is inferred from development reason codes or `none_recorded`. Next functional work is dispatch and trip execution, including the shared cancellation/dispatch boundary, driver acknowledgement, rechecked eligibility and occupancy lifecycle. No production use is authorised by these local results.

## Review before the pull request (Claude, 15 November 2026)

The work above was done by another assistant on Abdullah's computer and was uncommitted. It was copied unchanged into a checkout of `feat/assignment` at `d49e120`, installed from the lockfile with `npm ci`, and checked in full. The first commit of this branch is that work as found, apart from two encoding repairs; the second holds the corrections below.

| Finding | Effect | Correction |
|---|---|---|
| The full API suite had not been run (the record lists four API test files). One slice 7 guard test failed: it forbids the word "booking" in the shipment module, which now names the state `booking_cancelled` | `npm run verify` failed | The guard allows that one state name and still refuses any booking route or field. The route list it checks is unchanged |
| The shipments list offers a "booking cancelled" filter, but the database list function (migration 0008) refuses that status | Choosing the filter made the API fail with a server error | Migration 0017 also replaces `list_shipment_drafts`, accepting `booking_cancelled`; nothing else in it changes. A test lists the cancelled shipment through the filter |
| Republishing recorded the earlier state as `expired` in the history even when it was `booking_cancelled` | Wrong history entry | Republish records the state it actually left. A test checks the entry after a cancellation |
| Three characters were stored with a broken encoding (the inclusion marks ✓ and ✗, the dash between planned times, and the arrow in substitution differences) | Garbled symbols on the booking pages | Repaired on import |
| `offset_choices` is restated in 0017 identically to 0008 | None | Left as found |

Evidence after the corrections, on Linux with PostgreSQL 16.15:

| Check | Result |
|---|---|
| `npm ci` from the committed lockfile | Passed |
| `npm run verify` | Passed: API 323 pass, 0 fail, 0 todo; web 24; console 9 |
| The two new assertions | Fail against 0017 as found, pass with the correction |
| Web browser checks | All passed, including 5 cancellation checks and 11 assignment checks |
| Console browser checks | All passed (243) |

Not reviewed here: Windows-specific behaviour, Docker, physical phones, screen readers, and native Arabic and Urdu reading.

## Addition after approval (15 November 2026, 22:24): N-1

After confirmation, a vehicle replaced by one of the same category takes effect at once (slice 15). It is now also recorded in the shipper's history (`booking.vehicles_changed`, registrations only) and listed on the booking page for both parties. A change of driver, and a substitution the shipper accepted, are not listed there. Built in migration 0017 (`set_booking_assignment`, `vehicle_changes`, `booking_view`). Five deliberate defects were each caught by the assignment tests: the record not written, identifiers leaked, the record written to the carrier's history, a record before confirmation, a driver change counted.

Evidence after the addition, on Linux with PostgreSQL 16.15 and a recreated database: `npm run verify` passed (API 323 pass, 0 fail, 0 todo; web 24; console 9); web browser checks all passed, including 12 assignment checks with the replacement check in English, Arabic and Urdu; console browser checks all passed (243).
