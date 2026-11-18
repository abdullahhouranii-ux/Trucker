# Trucker: delivery outcome, custody and release, slice 18a record

Date: 18 November 2026. Branch `feat/delivery`, stacked on PR #34 (slice 17b). First part of slice 18 (phase five), built under Abdullah's instruction of 18 November 2026 (08:38, "agreed proceed") and the phase-five instruction of 17 November (11:46), on the development defaults DL-1 to DL-6 of `DELIVERY_SLICE_18_SCOPE.md`. That scope document is **for approval**: this record states what was built so it can be accepted or corrected. Slices 18b (proof of delivery) and 18c (disputes and holds) are not built. Nothing here is merged, deployed or approved for production.

## What changed

| Area | Change |
|---|---|
| Delivery outcome (DLV-1, DL-1, DL-2) | Once the trip has reached "arrived at delivery", and while it is not on hold, the assigned driver records one outcome: delivered in full, delivered with remarks, partly delivered, refused or not delivered. A receiver's name is needed except for refused and not delivered; remarks are needed except for delivered in full. The carrier's administrator or operations may record it on the driver's behalf, with a reason and the stated time, shown as reported (E-4). Anyone else is answered as for a missing record |
| One outcome in force (DLV-2, DL-6) | A party records the outcome once. Operations may correct it, with a note, as the next version; the earlier version stays visible to every party. No correction once a handover or a release is recorded |
| Operations case (DLV-3) | Any outcome other than delivered in full opens one operations case for the trip, shown to the parties like the other cases |
| Custody (DLV-4, DLV-5, DL-3, DL-4) | Partly delivered, refused and not delivered leave cargo in custody on the vehicle; delivered with remarks does when the recorder says so. Custody closes with one handover: returned to the shipper, delivered elsewhere, or handed to a replacement vehicle, with who handed over, who received, when and where. Recorded by the carrier's administrator or operations |
| Release (REL-1, REL-3, DL-5) | The carrier's administrator releases each resource, one at a time, only after an outcome and only when no cargo is in custody; otherwise refused with the reason. The release closes the occupancy episode and releases the reservation in one transaction, under the same locks as a dispatch. The resource can then be dispatched on its next booking. The driver and the shipper release nothing |
| Operations release (REL-2) | Operations may release with custody still open only with a note; it is recorded and shown as an operations release |
| Nothing else releases (REL-4, E-3) | An outcome, a milestone or the passage of time closes no episode. The database refuses closing an episode without its release record, reopening one, or removing one |
| What each party sees | The shipper sees the outcome, earlier versions and the handover, never the releases (resources stay as slice 15 shows them). The carrier and operations see the releases. Notes stay with their writer's side |
| Web | The trip shows the delivery. The driver's phone page offers the outcome form after arrival. The carrier's booking page offers the outcome on the driver's behalf, the handover form while custody is open, and a release button per resource. English, Arabic and Urdu |
| Console | The operations booking page shows the delivery and offers recording or correcting the outcome, the handover, and releases (with a note when custody is open) |

## Development defaults used (not approved for production)

DL-1 to DL-6 as recommended in the scope document.

## How it is built

Migration `0030_delivery.sql`, forward-only. New tables `trip_delivery_outcome` (versioned, never changed), `cargo_handover` (one per outcome) and `resource_release` (one per episode), all closed to the API's role. A trigger on `occupancy_episode` now lets an episode close only through its release record, once, and never be removed. The reservation's release reasons gain `trip_released`; cases gain the kind `delivery_outcome`. New callable functions: `trip_delivery_record`, `staff_delivery_record`, `cargo_handover_record`, `staff_cargo_handover`, `resource_release_record`, `staff_resource_release`. Changed: `trip_values` (the delivery), `operations_booking_values` (the assigned roles), `booking_consistency` (released members are not findings; new findings for a release not applied and a release with custody open).

API: `POST /organisations/:id/bookings/:bookingId/delivery`, `/handover`, `/resources/:role/release`; `POST /me/driver/assignments/:bookingId/delivery`; `POST /staff/operations/bookings/:id/delivery`, `/handover`, `/resources/:role/release`.

An existing assignment test closed occupancy episodes directly to simulate a release; it now writes the release record first, as the product must.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`trip/delivery.test.ts`) | 6 pass, 0 fail: DLV-1/E-3, DLV-1/3/4 (on behalf), REL-1/REL-3/DLV-5 (including the next booking dispatched after release, and direct writes refused), REL-2/DL-6, REL-5, and the waits under lock (a release waiting for the dispatch locks; an outcome that waited while the driver left; a handover written directly) |
| Deliberate faults | Sixteen faults in the migration, put in one at a time. Twelve were caught at once. Three were missed at first and are now caught by an added test: a handover written directly for an outcome with nothing in custody, a release taken without the dispatch locks, and the driver checked again once the trip is locked. One is not caught: letting the carrier's administrator release with custody open. No callable function can ask for that (only operations' function passes the override), so the database check is a second barrier with no route to test it through the API |
| `npm run verify` | Passed: API 406 pass, 0 fail (6 new); web 24; console 9 |
| Builds | Passed |
| Browser checks | Web: all passed, including a new journey on the phone and the booking pages: the driver records the remaining milestones and a partial delivery; the carrier's release is refused while cargo is in custody, the handover is recorded, and the truck and driver are released with no open episode left; the shipper sees the outcome and handover but no releases. Console: all passed, including the operations delivery panel with a fictional partial delivery in custody. Found and fixed: the handover form proposes the current minute, which the database refused as earlier than the outcome recorded seconds before; a handover time is now accepted from the minute of the outcome |

## Not done, and limits

- Proof of delivery (18b) and disputes with holds (18c).
- Who instructs and who pays for returning, storing or redelivering cargo is not decided (R-406); the handover records only what happened.
- Releasing a trailer is offered only when the booking has one; a booking whose resources are all released is not yet "closed" (closure, DB-16, is a later slice).
- Times entered are UTC, as on the other trip forms.
