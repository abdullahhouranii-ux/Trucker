# Trucker: exceptions and operations, slice 17b record

Date: 18 November 2026. Branch `feat/exceptions`, stacked on PR #33 (slice 17a). Second part of slice 17 (phase five). Abdullah approved the slice 17 scope document (DD-1 to DD-10) and the recommendation for a mistaken milestone on 18 November 2026 (06:10, "I accepted Scope doc and mistaken press. Approved proceed"). Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Operations privilege (DD-3) | A new staff privilege, **operations**, granted and removed by a staff administrator like the others. A reviewer or administrator without it cannot see the queue or act |
| Reporting (EXC-1, DD-10) | The driver, an administrator of the carrier or of the shipper reports an exception on a dispatched trip, with a type from the fixed list and a description. It is a case in the operations queue at once. A report needs an Idempotency-Key: the same report again returns the first case. The report form tells the driver to call the country's emergency number first; Trucker sends no emergency service |
| Handling (EXC-2) | Operations acknowledges a case, records each action with a note, and resolves it with a note. A case only moves forward, on the version it was read at. Every step records who and when. The parties' history shows the state changes, never the notes |
| What the parties see (EXC-5) | Every party sees each case on the trip, its type and its state. The description only to the side that reported it, and to the carrier for its driver's reports. Notes stay with operations |
| System cases (EXC-3, DD-9, N-6) | A resource still occupied past its planned end opens one case for its trip, linked to every later booking it puts at risk. A trip with no arrival at pick-up by the end of the pick-up window opens one case. Each is recorded once however often it is seen: by any command that touches bookings, by the operations pages, and by a job every minute. Neither has any other consequence |
| Blocking a dispatch (DB-9, DD-4) | Operations blocks a booking's dispatch with a reason from a fixed list (safety review, document concern, suspected fraud, other) and a note, and lifts it with a note. The parties see that Trucker operations blocked dispatch and the reason, never the note; the carrier's dispatch is refused with that reason. A block is taken under the same locks as a dispatch, so the two never cross; after dispatch a block is refused |
| Holding a trip (EXC-4) | Operations puts a dispatched trip on hold with a reason and a note, and resumes it with a note. On hold, no milestone is recorded, by the driver, the carrier or operations. The parties and the driver see the hold and its reason |
| On the driver's behalf (DD-6) | Operations records the next milestone with a stated time and a reason, as the carrier can. The parties see it was reported by Trucker operations, not by whom |
| A mistaken milestone (approved 18 November) | Operations withdraws the latest milestone in force with a note. It stays in the record, shown to every party as withdrawn (when, and to operations why); the trip goes back one step and the step can be recorded again |
| Web | The trip shows the hold, the problems reported and the withdrawn milestones. A "Report a problem" form for the driver, the carrier and the shipper. A dispatch blocked by operations names the reason. English, Arabic and Urdu |
| Console | Operations: the queue of open cases with the step each allows, the blocks and holds in force, recently resolved cases, and a page for one booking (block or lift, hold or resume, record on behalf, withdraw, the cases). The staff accounts page offers the new privilege |

## Development defaults used (not approved for production)

DD-1 to DD-10 are approved as the slice scope. Further values chosen here:

| Item | Value used |
|---|---|
| XS-1 | Who may report: the driver of the trip, and administrators of the carrier and of the shipper. Not other members |
| XS-2 | A hold uses the same reasons as a block (DD-4's list) |
| XS-3 | Every operations step needs a note, except acknowledging a case. Notes and descriptions are up to 1000 or 2000 characters |
| XS-4 | Only the latest milestone in force can be withdrawn, by operations only; the carrier and the driver cannot withdraw |
| XS-5 | The overrun and pick-up watches run every minute (`TRIP_WATCH_INTERVAL_MS`), and also whenever a command touches bookings or operations opens the queue |

## How it is built

Migration `0029_exceptions.sql`, forward-only. New tables `dispatch_block`, `trip_hold`, `trip_milestone_withdrawal`, `trip_case`, `trip_case_booking` and `trip_case_event`, all closed to the API's role; guards refuse removing any of them and allow only the forward moves (a block or hold lifted once; a case open, acknowledged, resolved). `trip_milestone` gains `recorded_by_staff`; one milestone in force per step is now enforced by a trigger under the trip's lock, and the trip may move back one step only when its latest milestone is withdrawn. New callable functions: `trip_exception_report`, `staff_operations_queue`, `staff_operations_booking`, `staff_case_act`, `staff_dispatch_block`, `staff_trip_hold`, `staff_milestone_on_behalf`, `staff_milestone_withdraw`, `trip_watch`. Changed: `booking_dispatch_blockers` (the block), `booking_view` (the shipper sees the block's reason), `trip_values` (hold, cases, withdrawn milestones, who entered), `trip_milestone_add` (hold, operations, withdrawn milestones ignored), `overrun_note` (the system cases), `staff_set_privilege`.

API: `POST /organisations/:id/bookings/:bookingId/exceptions` and `POST /me/driver/assignments/:bookingId/exceptions` (Idempotency-Key required); `GET /staff/operations`, `GET /staff/operations/bookings/:id`, `POST /staff/operations/cases/:id/action`, `POST /staff/operations/bookings/:id/block`, `/hold`, `/milestones`, `/milestones/withdraw`. `TripWatchJob` runs the watch. Milestones refused on hold answer 409 `trip_on_hold`.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`trip/exception.test.ts`) | 8 pass, 0 fail: EXC-1/EXC-5, EXC-2, DB-9/DD-4 (including a block and a dispatch at the same moment), EXC-4 (including a hold that waited for the trip), DD-6, the withdrawn milestone, EXC-3/DD-9, and a report that waited while the driver left |
| Deliberate faults | Fifteen faults in the migration, put in one at a time: the privilege, the hold check, who sees a description, the pick-up watch, the block as a blocker, a block after dispatch, the block's locks, a case's step order and version, which milestone can be withdrawn, one milestone in force per step, the previous milestone ignoring withdrawn ones, withdrawn milestones still listed in force, a repeated report key, and the reporter checked again once the trip is locked. Twelve were caught at once. Three were missed at first: the block's locks, the previous milestone after a withdrawal, and the check after the lock. Tests were added (a block that waits while the shipment is locked; a milestone recorded again between the departure and the withdrawn one; a report that waited while the driver left) and all fifteen are now caught |
| `npm run verify` | Passed: API 400 pass, 0 fail (8 new); web 24; console 9 |
| Builds | Passed |
| Browser checks | Web: all passed, including a problem reported by the driver from the phone form (with the emergency notice), seen with its description by the carrier and by type and state only by the shipper, in English, Arabic and Urdu with the layout, keyboard and rules checks. Console: all passed, including the Operations pages empty and with a fixed fictional queue and booking in every state, and steps sent from them refused by the real API (no such case or booking). Found and fixed: booking links in the console were too small a target. The console's keyboard check stopped at a date and time field, which takes one Tab per part; it now continues while the focus stays in the same field and still fails on any control never reached |

## Not done, and limits

- No notifications: operations sees cases in the queue; nobody is told by message.
- A case is not linked to a hold or a block: operations records in its notes which it used.
- The system cases are seen at most a minute late when nothing else happens; the queue page also records them when opened.
- Times entered in the console are UTC, as on the web pages.
- The emergency notice names no number: emergency numbers per country are not recorded in Trucker.
