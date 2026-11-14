# Trucker: shipment publication slice 10, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **approved by Abdullah on 15 November 2026, with PB-1 to PB-5 and the clarifications in section 5.** Repository copy: `docs/delivery/SHIPMENT_PUBLICATION_SLICE_10_SCOPE.md`; record of what was built: `SHIPMENT_PUBLICATION_SLICE_10.md`. Sources: `docs/specs/STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md` section 4 (journey J2, AT-201 to AT-205), Stage 1 baseline decisions, the decision update of 14 November 2026 (D-001 decided: agent), slices 7 and 9 as merged.

## 1. What this slice is

An administrator of a shipper organisation that may publish turns a complete shipment draft into a **published shipment** with a quotation deadline. The shipper can see it, change it (each material change is a new numbered version), withdraw it, and see it expire when the deadline passes. Staff can see published shipments in the console, read-only. Every change is audited.

"May publish" is the server's existing check from slice 9: verified, holding the `ship` capability, and never in a production database on demonstration evidence. So in production nothing can be published until real verification evidence, real lanes and a real cargo catalogue are approved. In development it works end to end on fictional countries, lanes and catalogues.

## 2. Out of this slice

Carrier discovery, quotations, counter-offers, acceptance, booking, reservations, prices, currencies, Trucker's fee (D-001a, D-001b), payment (D-002), notifications to carriers, partner API access, operations publishing on a shipper's behalf, attachments, declared value (P-208), invited-carrier lists (C-41), and every decision listed in section 6 as blocking production.

## 3. How it works

| Topic | Proposal |
|---|---|
| Who | An administrator of the organisation (the only role that exists), when `organisation_may_publish()` says yes at the moment of publishing, judged by the database after its locks |
| From what | A shipment draft of that organisation. Publishing does not copy the draft into a second record: the draft's own record moves from `draft` to `published` and keeps its history |
| Complete before publishing | Every field the publication rules need is present and valid: both places with country, time zone, area (PB-4) and address; both windows with resolved moments; cargo category and equipment type from the catalogues (PB-2); weight; dangerous-goods answer (PB-2); quotation deadline (PB-3). Each missing or invalid item is reported by field, in three languages |
| Time rules | Windows start in the future when publishing; delivery does not end before pick-up starts; the quotation deadline is before the pick-up window starts. All judged by the database clock, after any lock wait. Existing rules for skipped and repeated local times stay |
| Route | The route check from slice 7 must answer `open` at the moment of publishing. "Open" stays configured availability, not legal clearance |
| States | `draft` → `published` → `withdrawn` or `expired`. A discarded draft cannot be published. `awarded` and `closed` belong to later slices |
| Versions | The published shipment carries a version number. A change of a material field (PB-3) creates a new numbered version and keeps the earlier one readable; a minor change does not |
| Withdrawing | By an administrator, at any time while published. Kept with its history. Cannot be undone; publishing again needs a new draft made from a copy (PB-3) |
| Expiry | When the quotation deadline passes, the shipment is expired. Judged by the database clock at every read, so no worker is needed for correctness. The first read or change after the deadline records the expiry, exactly once, under the shipment's lock, dated at the deadline. An expired shipment may be published again as a new version once every check passes again (PB-3) |
| Retries | Publish, change and withdraw carry retry keys and the version they were made against, as in slices 5 and 7. A lost answer is reported as not confirmed; sending it again applies nothing twice |
| What carriers will see | A named projection (database function), defined and tested now; shown to the shipper as a read-only preview "What carriers will see". Nobody else can read it in this slice (PB-1, PB-4) |
| Staff | Reviewers and administrators see a read-only list and detail of published shipments in the console. Each view is audited, as for applications |
| Limits | Open published shipments per organisation and minimum lead time for the deadline are protected settings with development defaults, needing production review, like SD-5 |

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| PUB-1 | Only an administrator of the organisation can publish, change or withdraw its shipments; another organisation's shipment answers exactly like one that does not exist (AT-111, AT-201) |
| PUB-2 | Publishing is refused when `organisation_may_publish()` is false: draft, submitted, changes requested, rejected, verification withdrawn, capability revoked, and a production-marked database on demonstration evidence |
| PUB-3 | An incomplete or invalid draft is refused with every problem reported by field; nothing is published |
| PUB-4 | Publishing is refused when the route is not open, the category is excluded or unknown, or dangerous goods are declared (subject to PB-2) |
| PUB-5 | Windows in the past, a deadline at or after the pick-up start, or a deadline sooner than the minimum lead time, are refused, judged by the database clock after locks |
| PUB-6 | A repeated publish, change or withdraw with the same key and content applies once (AT-205); a different content with the same key is refused; a stale version is refused |
| PUB-7 | A change to any field carriers would see, to the deadline or to the dangerous-goods answer creates a new version and keeps every earlier version readable; any other change does not (AT-203, without quotations yet) |
| PUB-8 | A withdrawn or expired shipment cannot be changed; a discarded draft cannot be published |
| PUB-9 | Expiry happens exactly at the deadline by the database clock, including for a request that waited behind a lock |
| PUB-10 | The projection contains only the fields approved in PB-4 and never addresses, access notes, the shipper's reference, the shipper's identity (subject to PB-4) or anyone's contact details (AT-202) |
| PUB-11 | Windows are shown in each place's own time zone, named, for viewers in other zones (AT-204) |
| PUB-12 | When the shipper's verification is withdrawn, or the route closes, while a shipment is published, it is suspended for that cause; causes are kept separate and each transition is audited once; it resumes only after every condition is checked again; expiry takes precedence; nothing is cancelled |
| PUB-13 | The API's database role cannot set a shipment's status, version or projection directly; every change goes through the database functions; direct calls are tested as that role |
| PUB-14 | Every publish, change, withdrawal and expiry leaves one organisation audit entry; staff views leave one staff audit entry |
| PUB-15 | After the migrations no cargo category, equipment type or lane exists; fictional catalogue entries load only into marked databases |
| PUB-16 | Shipper screens work in English, Arabic and Urdu at phone widths and with text doubled; console screens pass the same automated checks; a lost answer is checked in the browser for publishing, and for every operation by repeated requests in the API tests |
| PUB-17 | No quotation, price, fee, booking or payment route, field, word or screen is added (the quotation deadline itself excepted) |
| PUB-18 | Concurrent changes, lost responses and requests that cross the deadline are tested: one outcome, nothing applied twice, audit events exactly once |

## 5. Decisions (approved 15 November 2026)

| ID | Decision, as approved with Abdullah's clarifications |
|---|---|
| PB-1 | Shipper publication, staff read-only views and the carrier preview only. No carrier access yet |
| PB-2 | Fictional cargo and equipment catalogues only; production registers stay empty. The dangerous-goods answer is mandatory, and "yes" blocks publication |
| PB-3 | Two-hour development lead time. Changes to carrier-visible fields, to the deadline and to the dangerous-goods answer are material. A withdrawn shipment needs a new draft copy; an expired shipment may be published again as a new version after every check passes again |
| PB-4 | The field allowlist as proposed, with the shipper's identity hidden. Free-text descriptions can reveal identities or contacts: the shipper is told so, and anonymity is never claimed to be guaranteed |
| PB-5 | Suspension blocks discovery and new quotations without cancelling work. Every eligibility condition is checked again before resuming; expiry takes precedence; suspension causes are kept separate and transitions audited once |
| Also | Expiry correct without a worker; audit events recorded exactly once; concurrent changes, lost responses and requests crossing the deadline tested |

## 6. Decisions that block production use, not this build

These are already open in the register; this slice does not decide or work around them.

| ID | Decision | Why it blocks production publication |
|---|---|---|
| D-003c, D-003b | First lanes and enabled countries. **Undecided.** No country or lane is chosen by this slice or by the decision update's earlier recommendation; the target stays the Middle East with GCC priority | No lane is open in production, so every route is closed |
| D-006 | Real cargo and equipment catalogue and exclusions | Catalogues are empty in production |
| Verification evidence (E-4) | Real evidence requirements, document storage and checking | Demonstration verification never allows production publication |
| SEC-01 | Concurrent administrator removal | Blocks real staff use, so no staff can verify anyone |
| Terms | Approved legal terms | Production registration is closed |

## 7. Routine choices (made during the build, reported, not asked)

Storage layout, function names, page layout, the protected-setting names, how the projection is exposed to the preview, test design, and the console list layout.

## 8. Carried forward, unchanged

All production gates in `SECURITY_BACKLOG.md`; SEC-01 open and deferred; staging CI diagnosis behind PR #9 "inferred"; the slice-4 unexplained API test failure unresolved; development-default settings need production review; wording and translation corrections go to the final-audit backlog.
