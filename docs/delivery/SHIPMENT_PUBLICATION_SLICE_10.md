# Trucker: shipment publication slice 10, record

Date: 15 November 2026. Branch `feat/shipment-publication`, from staging at `4e8ff97`. Scope and decisions: `SHIPMENT_PUBLICATION_SLICE_10_SCOPE.md` (PB-1 to PB-5 with clarifications, PUB-1 to PUB-18).

No carrier can read any shipment. Cargo categories and equipment types are fictional and exist only in databases marked for local development or tests; production registers are empty, so nothing is publishable in production. No launch country or lane is chosen: D-003b and D-003c stay undecided, with the Middle East as the target and GCC priority.

## 1. What was built

| Part | Where |
|---|---|
| Catalogues, publication columns, versions, suspensions, the settle logic, every publication function, staff read functions; slice 7's draft functions replaced to act on drafts only | `db/migrations/0008_shipment_publication.sql` |
| Fictional catalogues | `db/fixtures/local-development/countries.json`, loader in `apps/api/src/database/local.ts` |
| Routes: catalogues, publish, change, withdraw, republish, copy, publication record | `apps/api/src/shipment/` |
| Staff routes `GET /staff/shipments`, `GET /staff/shipments/:id` | `apps/api/src/staff/` |
| Shipper screens in English, Arabic and Urdu: publish form, publication facts and versions, carrier preview, change page, withdraw, publish again, copy; list filters by state | `apps/web/src/app/[locale]/organisations/[id]/shipments/`, `components/publication-*.tsx` |
| Console: published shipments, read-only | `apps/console/src/app/shipments/` |

## 2. How it works

**One record.** A published shipment is the draft's own record, moved on: `draft` → `published` → `withdrawn` or `expired`, with `published` shown as `suspended` while a suspension is open. A discarded draft cannot be published. Slice 7's save and discard now answer "not a draft" for anything else; before this slice they refused only discarded rows, which would have let an ordinary save rewrite a published shipment.

**Publishing.** The database decides, after locking the organisation and then the shipment and reading its clock: the organisation may publish (slice 9's rule); every field publication needs is present (places with country, zone, address and area; resolved windows; description; weight; category; equipment type; dangerous-goods answer; deadline); pick-up is in the future; the deadline is in the future, at least the lead time ahead (protected setting, 120 minutes by default) and before pick-up; the route is open; the category is not excluded; the dangerous-goods answer is "no". Every problem is reported by field.

**Versions (PB-3).** What carriers would see, the deadline and the dangerous-goods answer form the material values. A change that alters them is a new published version, kept unchanged afterwards; a change to the reference, the addresses or access notes is not. The exact address is minor under this rule because carriers do not see it. A change that alters nothing writes nothing.

**Expiry without a worker.** State is judged against the database clock at every read: the list function computes it, and a test reads it as the API role before anything is recorded. Every API read and change first asks the database to bring the shipment up to date, which records the expiry under the shipment's row lock, dated at the deadline, with no actor. Expiry is recorded once per publication cycle (adjustment of 15 Nov 2026, below): each shipment carries an explicit cycle identifier, new at publication and at each republication and unchanged by changes within the cycle, and a unique index on the history allows one expiry entry per shipment and cycle whatever happens. A request that waited behind a lock while the deadline passed finds the shipment expired and is refused; the expiry it found is kept, because definite refusals are now committed rather than rolled back (they write nothing else).

**Suspension (PB-5).** One record per cause, verification or route, opened and ended once each, each transition one history entry. When slice 9's staff functions withdraw or restore a verification, a trigger rechecks the organisation's published shipments in the same transaction; route changes are found at the next read. A cause ends only when its own condition passes again; the shipment is no longer suspended only when no cause is open. Expiry is decided first, and ends any open suspension with it. Locks are taken organisation first everywhere, so a publication racing a verification withdrawal either is refused or ends up suspended.

**What carriers would see (PB-4).** A named projection: the lane's countries, a town or area per place, windows in local time with the zone, cargo category, description, weight, pieces, packaging, equipment type and notes, the dangerous-goods answer, the deadline, and the shipper as "verified shipper". The shipper sees it as a preview and is told that free text is shown as written and anonymity is not guaranteed. Nobody else can read it.

## 3. Routine choices made during the build

- The deadline is typed as the time at the pick-up place, with the same rules for skipped and repeated times as the windows.
- Equipment notes (the slice 7 free-text field) are shown to carriers, as part of "equipment"; the caution covers them.
- Copying is allowed from withdrawn and expired shipments; the copy has no deadline.
- Staff views need `reviewer` or `staff_admin`. The console shows the projection as raw data (presentation item WD-18).
- Published shipments per organisation: protected setting, development default 50.
- Route rechecks during settle use the database's own marking for fictional countries.

## 4. Checks run (local)

| Check | Result |
|---|---|
| `npm run verify` | Passed |
| API tests | 248 passed, 0 failed, 1 marked todo (SEC-01); 19 new publication tests; slice 7 and hardening tests updated for the new routes and functions |
| Web browser checks | 1,368 checks, 0 failed; 7 publication checks and 4 lost-answer checks (publication and withdrawal); 16 publication screen states inspected in three languages |
| Console browser checks | 211 checks, 0 failed; 5 for published shipments |
| Defect injection | Ten defects put into the migration one at a time (no settle on entry, expiry dated when recorded, no verification triggers, deadline not material, one passing cause ending every suspension, no eligibility check, address in the projection, no lead check, dangerous goods accepted, draft save acting on a published shipment). Each made at least one test fail. Restored byte for byte |

## 5. Not verified, and limits

- A lost answer to a change, republication or copy is tested by repeated requests in the API tests, not in the browser. Lost publication and withdrawal answers are tested in the browser.
- In the browser checks the real clock cannot move: the expired state is reached by moving the record's own times back consistently, with the migration role.
- A closed route is found at the next read of the shipment, not at the moment the lane is closed; lanes are changed only by the migration role.
- Screen readers were not used. Arabic and Urdu are drafts (TR-12).
- SEC-01 stays deferred and blocks production and real staff use.

## 6. Adjustment of 15 Nov 2026: expiry once per publication cycle

**Defect.** The first version allowed one expiry entry per shipment for its whole life. A shipment published, expired, republished and past its new deadline would have hit that unique index at the read that records the second expiry: a server error (500) on every read, and the shipment never recorded as expired again. Confirmed by putting the old index back: the new regression test fails with 500.

**Change (migration 0008, unmerged, edited in place).**
- `shipment_draft.publication_cycle`: a new identifier at publication and at each republication, kept by every change within the cycle; empty exactly while the record is a draft or discarded. A copy starts as a draft with none.
- Each published version, and each history entry about a published shipment (published, version created, withdrawn, expired, republished, suspended, suspension ended), names its cycle. An expiry entry must name one. A republication entry also names the previous cycle.
- The unique index is now one expiry per shipment and cycle. Expiry is still recorded under the shipment's row lock, so concurrent reads serialise and the second finds it already expired.
- The API's shipment view shows `publicationCycle`.

**Tests.** API: publish → material change (cycle kept) → expire → republish (new cycle) → expire again. Each cycle has exactly one expiry entry; concurrent and repeated reads, lists and publication reads all answer 200 and add nothing; versions and history name their cycles. The hand-written duplicate is refused for the same cycle, and an expiry entry without a cycle is refused. Browser: a lost withdrawal answer. The withdrawal commits, the answer is lost, the page does not report it done, the retry shows it withdrawn, and sending the same request again with the same key answers "already withdrawn" with the same version, the same withdrawal time and one withdrawal entry.
