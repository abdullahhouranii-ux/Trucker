# Trucker: dispatch and milestones, slice 17a record

Date: 17 November 2026. Branch `feat/dispatch`, stacked on PR #32. First part of slice 17 (phase five), built under Abdullah's instruction "Start with dispatch" of 17 November 2026, with DD-1 to DD-10 of `DISPATCH_SLICE_17_SCOPE.md` used as development defaults (instruction of 17 November, 11:46). The scope document itself is still "for approval": this record states what was built so it can be accepted or corrected. Slice 17b (exceptions, the operations privilege, cases and holds) is not built. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Dispatch (DSP-1, DD-1) | One step. An administrator of the booking's carrier dispatches; anyone else is answered as for a missing record. The database checks every precondition of section 3 at that moment, after the locks, and the refusal names the first that fails: the booking page's blockers, then an open substitution, then the parties' capabilities, then the earliest time. A dispatch needs an Idempotency-Key; a repeated request returns the first trip and changes nothing |
| Dispatch window (DD-2) | Not earlier than 12 hours before the planned reservation start (protected setting `dispatch_lead_hours`, 1 to 72). No latest time: a dispatch after the planned start is allowed and shown as late. The booking page shows the earliest time |
| What dispatch does (DSP-4, TRP-7) | Creates the trip and opens one occupancy episode for each assigned resource, in one transaction, with a history entry for each party. Nothing in this slice closes an episode |
| After dispatch (DSP-5, DSP-7) | Cancellation, assignment, substitution decisions, the driver's acknowledgement and the shipper's wait decision are refused (`booking_dispatched`). The database refuses direct writes to the assignment tables of a dispatched booking. The booking page no longer offers cancelling or assigning |
| Milestones (TRP-1, DD-5) | Six, in order: left for pick-up, arrived at pick-up, loading started, loaded and left, arrived at delivery, unloading started. A skipped or repeated step is refused with the current trip; a stale version is refused as changed. The delivery outcome is slice 18 |
| The driver (TRP-2) | Only the assigned driver, while affiliated with the carrier, records milestones as the driver, with the time of recording (observed). A driver who left records nothing, including one whose request waited for the trip while they left (TRP-8) |
| On the driver's behalf (TRP-3, DD-6) | The carrier's administrator records the next milestone with a stated time and a reason (no phone, no signal, driver unable, correction, other with a note). It is shown as reported, with who entered it and for whom. A time in the future is refused; one earlier than the previous milestone, or before dispatch, is kept and marked for review. The note is shown to the carrier only |
| Estimate (DD-7) | The driver or the carrier's administrator states an estimated arrival at delivery, at any time after dispatch until arrival at delivery; not in the past and not more than 30 days ahead. The parties see the latest, with who stated it and when |
| What each party sees (TRP-5, TRP-6, DD-8) | The shipper sees the trip's milestones and estimate, and nothing more about resources than slice 15 shows. The driver sees, from dispatch and not before, the addresses and access notes from the confirmation record and the shipper's name; never the price or the fee |
| Consistency | The booking consistency check gains two findings: a trip whose resource has no open episode, and a booking both dispatched and cancelled |
| Web | Booking page: a Trip section for the carrier with the dispatch button and the earliest time, then the trip, the on-behalf form and the estimate form; the shipper sees the trip. Driver page: from dispatch, the shipper, the addresses, the trip, a button for the next milestone and the estimate form. Times entered are UTC, and the pages say so. English, Arabic and Urdu |

## Development defaults used (not approved for production)

DD-1, DD-2, DD-5, DD-6, DD-7 and DD-8 as recommended in the scope document. DD-3, DD-4, DD-9 and DD-10 belong to 17b and are not built. Further values chosen here:

| Item | Value used |
|---|---|
| DS-1 | An estimate more than 30 days ahead is refused as not valid |
| DS-2 | The on-behalf note is up to 500 characters and is required for "other" |
| DS-3 | Times typed on a page are UTC. There is no per-site time zone in the web pages yet |

## How it is built

Migration `0028_dispatch.sql`, forward-only. Tables `trip` (one per booking; only the milestone count and version move, by one), `trip_milestone` and `trip_estimate` (never changed once written), all closed to the API's role. A guard on the assignment tables refuses changes for a dispatched booking. New callable functions: `dispatch_booking`, `trip_milestone_by_driver`, `trip_milestone_on_behalf`, `trip_estimate_state`. Every one locks first, then reads the clock (which rechecks the session, as in PR #31's review fix), then decides. `booking_view` gains `dispatchFrom` and `trip`; `driver_assignments` gains `trip`, `site` and `shipper` once dispatched. Existing functions that change a booking answer `already_dispatched` after dispatch.

API: `TripService`; routes `POST /organisations/:id/bookings/:bookingId/dispatch` (Idempotency-Key required), `/milestones`, `/estimate`; `POST /me/driver/assignments/:bookingId/milestones` and `/estimate`. A refused dispatch answers 409 `dispatch_refused` with the reason and, for a resource, the role and cause.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`trip/trip.test.ts`) | 9 pass, 0 fail: DSP-1/4, DSP-2/3 (DSP-3 shown with a vehicle suspended a minute earlier: refused, needs reassignment, cause suspended), DSP-5, DSP-6 (simultaneous, and an overrunning resource), DSP-7/TRP-7, TRP-1/2, TRP-3/4/5, TRP-6, TRP-8 |
| Deliberate faults | Nine faults in the migration, put in one at a time: no earliest time, no sequence check, no version check, future times accepted, nothing marked for review, estimates after arrival, no driver check before the lock, no driver check after the lock, and the "already dispatched" refusals removed. Seven were caught at once. The check after the lock was missed at first; TRP-8 was added and catches it. The check before the lock is still not caught by any test, because the check after the lock gives the same answer: it is kept as an early refusal |
| `npm run verify` | Passed: API 392 pass, 0 fail (9 new); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed (console checks too), with one new journey (an early dispatch refused with its reason; after the window is widened for the run, dispatch; the driver's addresses and first milestone; a milestone on the driver's behalf with a note the shipper does not see; the driver's estimate seen by the shipper; layout, keyboard and rules checks in English, Arabic and Urdu). Found and fixed: the time fields were too small a target, the review notice overlapped the note above it, and an empty "Ready for dispatch?" heading stayed after dispatch |

## Not done, and limits

- Slice 17b: exceptions, the operations privilege, operations blocks (DSP-2's operations-block precondition cannot fail until then), cases, holds.
- No location, tracking, photos, messaging, notifications or offline queue (section 4 of the scope).
- DSP-3 is shown with a suspension rather than a document lapsing, because a lapse a minute earlier and a suspension take the same path (the booking page's eligibility); a test with a lapsing document date was not added.
- The browser journey moves the dispatch window setting to 72 hours for its run, because the real clock cannot be moved there; the API tests cover the 12-hour default with a test clock.
- Times entered are UTC (DS-3). Showing and entering them in the site's local time needs the site's time zone in the web pages; it is listed in the final-audit backlog.
