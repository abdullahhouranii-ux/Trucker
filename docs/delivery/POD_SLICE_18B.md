# Trucker: proof of delivery, slice 18b record

Date: 18 November 2026. Branch `feat/pod`, stacked on PR #37 (Node 24), which is stacked on PR #36 (slice 18d). Built under Abdullah's instruction of 18 November 2026 (22:08, "now", after the proposal to start 18b) and the phase-five instruction of 17 November (11:46), on the development defaults PD-1 to PD-7 below. The slice 18 scope (`DELIVERY_SLICE_18_SCOPE.md`) said 18b would be scoped in detail before it is built; this record is that detail and is **for approval**: it states what was built so it can be accepted or corrected. Nothing here is merged, deployed or approved for production. Slice 18c (disputes and holds) is not built.

## What changed

| Area | Change |
|---|---|
| Manifest first (DI-402) | Once a delivery outcome is recorded, and while the trip is not on hold, the assigned driver declares a version of the proof of delivery (POD): each item's kind (receiver's signature, signed document, delivery note, photo of the cargo, other), file type, size and SHA-256 fingerprint, and whether it is optional. The receiver's name, role and remarks are recorded with it. Each version names the version number it creates: a stale or simultaneous one is refused |
| What each outcome needs (PD-1) | Delivered in full, delivered with remarks or partly delivered: the receiver's signature or a signed document; partly delivered also a photo of the cargo; refused or not delivered: a photo. The receiver is named unless nothing was delivered. A manifest without what its outcome needs is refused with what is missing |
| Files (DI-405, AT-402) | Each file is sent as its own bytes. The API computes its fingerprint and size on what arrived and the database compares them with the declaration: a file that differs is refused, recorded in the audit as an integrity failure, and not kept. Only JPEG, PNG and PDF, at most 10 MB, at most 10 items (PD-2). A larger body is refused before it is all read. Sending the same file again changes nothing |
| States | Not received (nothing declared: the trip shows that evidence is awaited, never "no POD"), upload incomplete, ready for review, accepted, more evidence requested, superseded. Ready means every required item arrived; optional ones may still be missing |
| On someone's behalf (E-4) | The carrier's administrator, or operations from the console, may declare and upload on the driver's behalf with a reason (no phone, no signal, driver unable, phone lost, paper copy handed in, other with a note) and the stated capture time, which may not be in the future or before the outcome. It is shown as reported, with who it is about and who entered it |
| Review (E-1, DB-12) | Only the shipper's administrators decide: accept, or ask for more evidence with a note saying what is missing. A decision names the version; a replaced or already decided version is refused; two decisions at once leave exactly one (AT-412). Not before every required item has arrived |
| No silence (R-402, AT-413) | Nothing is accepted by the passage of time: there is no timer and no job that accepts |
| No side effects (E-3, AT-414) | Accepting moves no money, places or lifts no hold, releases no resource and closes no occupancy. The page says so |
| Versions (AT-403) | Asking for more evidence opens the way for a new version, which needs its reason. Earlier versions and their files stay readable to reviewers. An accepted POD is not replaced |
| Who may read a file (AT-405) | The parties to the booking: the assigned driver, and the carrier's and shipper's administrators. Anyone else, including another organisation, is answered as for a missing record. Files are sent privately, never cached, never interpreted as another type; PDFs are downloaded rather than shown. There are no shareable links |
| Staff views (AT-415) | Every view of a file by operations is recorded with who and when, and audited |
| Forward only | Declarations, decisions and views are never changed or removed; an item is marked received once |
| Storage (D-011, R1-V7) | Files are kept behind a storage interface outside the database. The only implementation is a development stand-in that writes to a folder on this machine (`FILE_STORAGE=local`, `FILE_STORAGE_DIR`), refused in production. Without it, upload answers that file storage is closed. A file is stored first and recorded second; if the database refuses it, the stored copy is removed |
| Web | The driver's phone page and the carrier's booking page offer the capture form (the carrier's on the driver's behalf), the list of versions with each file's state, and a form to send a file that did not arrive. The shipper's booking page offers the review. Files open through this site as the signed-in person. English, Arabic and Urdu |
| Console | The operations booking page shows every version and file (each open recorded) and uploads a paper POD on the driver's behalf. It never accepts on the shipper's behalf |

## Development defaults used (not approved for production)

| ID | Default | Why it needs a decision |
|---|---|---|
| PD-1 | Required evidence per outcome as above | DB-12 asks for a fixed list per outcome; the list itself is yours |
| PD-2 | JPEG, PNG and PDF; 10 MB per file; 10 items per version | File limits are an operating parameter in Part 4 |
| PD-3 | Only the shipper's administrators review (R-401 drafted: the shipper reviews) | Whether operations may accept on the shipper's behalf after a period with a reason (DB-12) is not built: E-1 stays |
| PD-4 | No review period and no reminder | R-402 (silence, review period) needs legal review |
| PD-5 | The fingerprint is computed by the web server on the bytes it received from the browser, then checked again by the API | A fingerprint computed on the phone at capture, with offline capture and resumable upload (AT-401), needs the mobile application |
| PD-6 | Files kept with no end date in the development stand-in | Retention (R-305) needs legal review; a storage supplier (D-011) is paid |
| PD-7 | No notification is sent | Notifications are not designed |

## How it is built

Migration `0032_pod.sql`, forward-only. New tables, closed to the API's role: `pod_version`, `pod_item`, `pod_review`, `pod_file_view`. New callable functions: `pod_declare`, `staff_pod_declare`, `pod_receive`, `staff_pod_receive`, `pod_review_record`, `pod_file`, `staff_pod_file`. `trip_values` gains the POD. Audit actions added: `trip.pod_declared`, `trip.pod_version_added`, `trip.pod_item_received`, `trip.pod_integrity_failed`, `trip.pod_accepted`, `trip.pod_more_evidence_requested`.

API: `POST /organisations/:id/bookings/:bookingId/pod`, `PUT .../pod/items/:itemId` (the file's bytes, `Content-Type` its type), `POST .../pod/review`, `GET .../pod/items/:itemId/file`; the same under `/me/driver/assignments/:bookingId/pod` for the driver (no review), and under `/staff/operations/bookings/:id/pod` for operations (no review). Configuration: `FILE_STORAGE` (`none` or `local`) and `FILE_STORAGE_DIR`.

## Evidence (Linux, Node 24.21.0, npm 11.19.0, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| New API tests (`trip/pod.test.ts`) | 5 pass, 0 fail. POD-1: who may capture (AT-404), the manifest's required evidence, a different file refused and not kept with the integrity failure audited (AT-402), the declared type only, JPEG/PNG/PDF only, a body over 10 MB refused, the same file sent twice, ready with an optional item missing (DI-402). POD-2: only the shipper decides (AT-411), a month of silence accepts nothing (AT-413), two decisions waiting on the trip leave one (AT-412), accepting changes no booking, payment, hold, release or occupancy (AT-414), an accepted POD is not replaced. POD-3: more evidence and a second version with its reason, a stale version refused, a decided version not decided again, a decision naming the wrong version refused, the first version's file still readable byte for byte (AT-403). POD-4: on behalf with reason and time, marked reported; another organisation and no sign-in read nothing (AT-405); the driver reads; an operations view recorded and audited (AT-415); records never changed or removed. POD-5: a paper POD by operations; a replaced version cannot be decided; production refuses the local stand-in |
| Deliberate faults | Fifteen faults in `0032`, one at a time; all are caught. Four were missed at first and are caught by changed or added checks: the shipper's check removed in both places, the decision taken without the trip's lock (now proved with both decisions waiting on a held trip), a replaced version decided, and a declaration on the driver's behalf without a reason |
| `npm run verify` | Passed: API 421 pass, 0 fail (5 new); web 24; console 9. It first failed on the hardening rule that no callable function takes a number other than the expected version: the file's byte count and the review's version were plain numbers. The byte count now travels in the receipt's JSON and the version is named `p_expected_version` |
| Builds | Passed |
| Browser checks | Web: all passed, including the driver sending a signature and a photo of the cargo from the phone page, the shipper seeing it ready, opening a file through the site and accepting it. Found and fixed: the "Open" links were too small to tap. Console: all passed |

## Not done, and limits

- Disputes and holds in general (18c); the "disputed" decision of Part 4 waits for it.
- Offline capture and resumable upload on the phone (AT-401); a fingerprint computed on the device (PD-5).
- A storage supplier, retention and deletion (D-011, R-305).
- Notifications, a review period and the "POD pending upload" threshold (PD-4, PD-7).
- Closure of the booking when the POD is accepted (slice 20).
