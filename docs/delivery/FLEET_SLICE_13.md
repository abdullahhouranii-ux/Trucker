# Trucker: fleet and drivers slice 13, record

Date: 15 November 2026. Branch `feat/fleet`, stacked on `docs/release-1-plan` (PR #18), which is stacked on PRs #17, #16 and #15, all unmerged. Scope: FLEET_SLICE_13_SCOPE.md (approved for development, with conditions FC-1 to FC-4).

Nothing is reserved, assigned, dispatched or booked. All document types, vehicle categories and licence classes are fictional. No file is stored.

## What was built

| Part | What it does |
|---|---|
| Migration `0012_fleet.sql` | Registers (vehicle categories, licence classes with the categories they cover, document types per country and subject), empty after migrations. Vehicles, driver affiliations, driver authorisations, documents, suspensions, retry keys. All are reached only through functions; the API role has no table rights |
| Ownership claim (FC-1 to FC-3) | Registering a vehicle records a claim. Staff verify or reject it. Another carrier's claim on the same registration is accepted in the same way, shown to staff only, and changes nothing for the first carrier. A partial unique index allows one verified claim per registration; a second verification is refused with `ownership_conflict` |
| Operating control | Its own function: in this release the organisation whose claim is verified. Another organisation asking about the vehicle is answered `not_operating_controller` |
| Documents | Type, number, issuing country, dates and, for a licence, its classes. Checked by field. One awaiting a decision and one accepted per subject and type; an accepted renewal replaces the earlier one; a rejected renewal leaves it standing. A document that lapsed while waiting cannot be accepted |
| Drivers (DB-5) | The carrier invites a mobile number. Whether a person has that number, or already works elsewhere, is not disclosed. Only the person with that number sees and answers the invitation. One active affiliation per person, enforced by a unique index. Either side can end it |
| Access to driver documents (FC-4) | While the affiliation is active the carrier sees each document's type, state, expiry and classes, never its number. After it ends the carrier sees none of it. The documents stay the driver's and follow them to another carrier of the same country |
| Authorisation | Per vehicle or for every vehicle of the carrier. Ends with the affiliation or the vehicle |
| Eligibility (DB-4) | `vehicle_eligibility` and `driver_eligibility` answer for a window `[from, until)` with `eligible` or the first reason: carrier capability, ownership, operating control, suspension, documents covering the window, equipment, affiliation, authorisation, licence class. They read the database clock and decide nothing about availability. The booking slices will call them inside their own locks |
| Suspension | Staff administrators suspend a vehicle or a driver with a reason, and end it. It takes effect at the next check and cancels nothing by itself |
| API | Carrier routes under `/organisations/:id/fleet`; the driver's under `/me/driver`; staff under `/staff/fleet` |
| Web | Fleet page and vehicle page for the carrier; a driver page made for a phone; links from the carrier page and the account page. EN, AR and UR (AR and UR drafts, TR-18) |
| Console | Fleet page: claims with the other claims on the same registration, documents, decisions with the independence declaration, suspensions |
| Development defaults (FB-5) | 200 vehicles and 200 drivers per carrier, 5 versions per document. Protected settings needing production review |

## Routine choices made during the build

| Choice | Why |
|---|---|
| A document counts until the start of its expiry date in UTC | No document is treated as valid after it lapsed, whatever the time zone. Whether the last day counts is listed in SECURITY_BACKLOG for a decision with the real rules |
| The driver, not the carrier, submits driver documents | They are the driver's own; the carrier never needs the numbers |
| Driver document types follow the carrier's country | The licence-class mapping is per country |
| The eligibility functions take no locks themselves | They are read-only building blocks; the caller that makes a decision holds its own locks |
| A former carrier can still retire vehicles and end affiliations | Losing the capability must not trap records |

## Defects found and fixed during the build

| Defect | Fix |
|---|---|
| A long licence-class name beside a tick box pushed the driver page sideways at doubled text | Choice labels wrap |
| An empty document form was reported as a general error, not by field | The web action reports the missing type, number, country and expiry by field |

## Evidence

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 292 pass, 0 fail, 0 todo; web 24; console 9 |
| Fleet API tests | 9 tests, all pass |
| Deliberate defects in 0012, each caught by the intended test | Window check removed (FLT-4); second verified claim allowed (FLT-2); another carrier's claim disclosed as "exists" (FLT-2); second active affiliation allowed (FLT-3); carrier keeps document access after the end (FLT-5); document numbers shown to the carrier (FLT-5); authorisation not required (FLT-5); licence class not required (FLT-5); capability not checked (FLT-6); independence not checked (FLT-7); operating control not checked (FLT-4). Migration restored, byte-identical |
| Web browser checks | All passed, including 11 fleet checks and the lost answers for vehicle registration and driver invitation, each recorded once; three languages at four widths and with text doubled |
| Console browser checks | All passed, including 5 fleet checks: a decision refused without the declaration, a verification, and a suspension |

## Not covered or still open

- CI has not run on this branch at the time of writing; see the PR.
- Real document requirements, vehicle categories and licence classes (X-5), and file storage (X-7).
- The full ownership-dispute process (Part 1, 3.8), delegated management and vehicle owners who are not carriers.
- Retention of driver documents and ended affiliations.
- Reservation, assignment and dispatch: slices 15 and 17. The reservation model is defined in RELEASE_1_DECISIONS.md, section 3.
