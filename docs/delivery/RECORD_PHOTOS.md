# Private photos for shipments and vehicles

Implemented by Codex locally (unreviewed branch `codex/unified-experience-mobile`) and split into its own branch, `feat/record-photos`, on 22 November 2026, stacked on `feat/public-shipments`. Migration 0040 (same number as Codex's).

## Behaviour

- An administrator of the owning company can add photos to a shipment (draft or published) or to an active vehicle, list them and open them. Nobody else can: another company, including through its own account, is answered as for a missing record. Photos are not shared with other parties; sharing would be a separate, explicit permission.
- JPEG or PNG only, checked on the bytes as well as the declared type; at most 5 MB each (decided by Abdullah, 22 November 2026; refused with 413 before anything is stored) and twelve per record. Each photo has an id chosen by the sender: sending the same picture again under it is accepted once, a different picture under it is refused.
- Files are kept in the same private file store as proof of delivery. Migration 0040 adds photo keys to the sweep of unrecorded files, so the sweep never removes a photo.
- The web shipment page and vehicle page show the photos, in English, Arabic and Urdu.
- **Keeping time** (decided by Abdullah, 22 November 2026: a setting). `record_photo_retention_days` is a protected setting, changed like the other limits with `npm run db:settings`. 0, the default, keeps every photo. With a period set, a photo's record is removed once its record has ended without a booking for that long: a shipment withdrawn, expired or discarded, or a vehicle retired. Each removal is audited, without an actor. The file is then removed by the sweep of unrecorded files after its grace period. Photos on a booked shipment are never removed this way: they may be needed for the trip or a dispute (development rule). The API runs this hourly, with the sweep.

## Verification (22 November 2026)

Node 24, isolated PostgreSQL, this branch alone.

| Check | Result |
| --- | --- |
| `npm run verify` (before 22 November) | API 431 pass, 0 fail, 2 skipped (two browser journeys, which pass when enabled); web 24/24; console 9/9 |
| Deliberate faults in 0040 | Seven, one at a time. Six caught: photo keys left out of the sweep, another company's shipment, another company's vehicle, different bytes under one id, no limit of twelve, a photo added to a retired vehicle. Five were missed at first; a test was added for them. On 22 November four more, all caught: a keeping time of 0 removing photos, the keeping time ignored, an active vehicle's photos removed, and no 5 MB check in the API The seventh, the administrator check, cannot fail on its own: every membership is an administrator, and a person who is not a member is refused before it |

## Decisions

- **Decided by Abdullah on 22 November 2026:** at most 5 MB a photo; the keeping time is a setting.
- **Still development defaults:** twelve photos per record, JPEG or PNG, the starting value 0 (keep), and which ended records lose their photos.
