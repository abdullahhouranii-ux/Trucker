# Trucker: shipment draft-and-list slice, scope and acceptance criteria

Version 1.0, 14 November 2026. Status: **approved by Abdullah with decisions SD-1 to SD-5** (13 November 2026). Record of what was built: `SHIPMENT_DRAFTS_SLICE_7.md`.

## 1. What this slice is

An administrator of a shipper organisation can save a private shipment draft, find it again in a list, change it and discard it. Nothing else.

Outside this slice, and absent from the code: publication, quotations, booking, payment, carriers seeing anything, cargo or equipment rules, prices, and every unresolved commercial rule (D-001, D-002, D-003b).

## 2. Decisions

| ID | Decision |
|---|---|
| SD-1 | An unverified (draft) organisation may save private shipment drafts. A draft grants no publication right and no commercial right |
| SD-2 | Fields as proposed. Weight and pieces are optional, validated numbers with explicit units and bounds. The descriptive fields stay free text |
| SD-3 | Route checks as proposed, including domestic routes and ordered transit countries. "Open" describes configured availability only. It is not legal clearance |
| SD-4 | Discard preserves the record and its history. It checks the version. A repeated discard creates no second audit entry |
| SD-5 | 200 open drafts per organisation and 20 drafts per page are development defaults. Both need explicit review before production |

## 3. Fields

Every field is optional. A draft with nothing in it is refused.

| Field | Rule |
|---|---|
| Your reference | Free text, at most 64 characters |
| What is being moved | Free text, at most 2,000 characters |
| Gross weight | **Kilograms.** A number greater than 0 and at most 100,000, with at most three decimal places (to the gram). No other unit is accepted or converted |
| Pieces | **Whole pieces.** 1 to 100,000 |
| Packaging | Free text, at most 200 characters |
| Equipment needed | Free text, at most 500 characters |
| Pick-up and delivery, each | Address (500), country, time zone, access notes (1,000), earliest time, latest time |

Text is stored as typed, in any script; only surrounding space is removed. The bounds on weight and pieces are input sanity bounds, not statements about what a vehicle may carry.

## 4. Times

1. A time is typed as the time on the clock at the place, and stored as typed.
2. A place's time zone is a named zone configured for its country. An offset alone is never stored as the zone.
3. The exact moment is worked out only when the place has a zone and the typed time occurs there. With no zone, the typed time is kept and no moment is stored. Nothing is assumed: no default zone, no default time, not even where a country has a single zone.
4. A time the clocks skip does not exist and is refused.
5. **A time that occurs twice (the clocks go back) is refused until the person chooses one of the two offsets.** Neither is assumed. The refusal names both offsets. A chosen offset is used only for such a time.
6. A window may not end before it starts, and delivery may not end before pick-up starts. These are compared as moments, and only when both moments are known. Whether a time is in the past is not judged.

## 5. Route check

Read from the registers at the moment of asking, never stored with the draft. Answers `unknown` (a place has no country), `open` or `closed`, with each part that is not open: origin country, destination country, the lane in that direction (missing or closed), or a transit country, in order. A domestic route is a lane from a country to itself. A draft is saved whatever its route.

After the migrations no operating state, time zone or lane exists, so every route is closed. Fictional countries and lanes are loaded only into a database marked for local development or test.

## 6. Stable pagination

Ordering by last change cannot keep pages stable, because an edit would move a draft between pages while someone is reading. The list is therefore ordered by **creation, newest first**, using a position the database assigns once and never changes.

- The cursor is the id of the last draft on the previous page. It must be a draft of the selected organisation; anything else is refused and shows nothing.
- No draft appears twice in one walk.
- Every draft that existed when the walk began and still matches the filter when its page is read appears exactly once.
- Changing a draft never moves it.
- A draft created during a walk appears only in a new walk.
- A draft discarded before its page is read is left out of the open list; nothing else shifts.
- A cursor still works after its own draft is discarded.
- The page size is the protected setting. The caller cannot raise it.

Cost, stated plainly: the most recently changed draft is not brought to the top.

## 7. Lost answers, retries and conflicts

Every create, change and discard carries a retry key that the form keeps.

Order in the database: authenticate, authorise, lock, read the clock, then look up the key.

| Situation | Result |
|---|---|
| Same key, same content, already applied | Answered as already applied. No second change and no second audit entry, even if a colleague has changed the draft since |
| Same key, different content | Refused: `retry_key_conflict` |
| New key, version no longer current | Refused: `shipment_changed`, with the current draft. Nothing is saved |
| Discard of a draft that is already discarded | Answered as already discarded, whatever key or version. No new audit entry |
| No answer reaches the web application | The page says the outcome is not known. It never says saved or discarded without confirmation. The form keeps the input and the key, so trying again asks for the same thing |

Keys are kept for the protected retention period (24 hours by default).

**Conflict.** When a colleague changed the draft meanwhile, nothing of the person's is saved and nothing they typed is lost: their input stays in the form, the saved draft is shown, and they choose between saving their version over it and dropping their changes.

## 8. Acceptance criteria

| ID | Criterion |
|---|---|
| SH-1 | An administrator saves a draft and reads back exactly what was given, in Arabic, Urdu or Latin script |
| SH-2 | An incomplete draft is saved; missing values stay missing; no time or zone is invented |
| SH-3 | Weight and pieces outside the bounds, or not numbers, are refused by field and nothing is saved |
| SH-4 | A draft of another organisation answers exactly like one that does not exist, in the API, the database role and the web pages |
| SH-5 | The API's database role can read drafts of the selected organisation only and can write nothing except through the functions |
| SH-6 | Create, change and discard behave as in section 7, including a change that waited behind a lock and a session that ended meanwhile |
| SH-7 | Pages behave as in section 6 while drafts are changed, added and discarded |
| SH-8 | The open-draft limit holds, also under simultaneous requests |
| SH-9 | Times behave as in section 4 |
| SH-10 | The route check behaves as in section 5, and the page says that open is not legal clearance |
| SH-11 | Each create, change and discard leaves one audit entry with who, when, the request and the values |
| SH-12 | The journey works in English, Arabic and Urdu, right to left where that applies, at phone widths and with text doubled |
| SH-13 | No route, word or screen for publication, quotation, booking or payment exists |

## 9. Carried forward, unchanged

- Production gates: encrypted database connection, parameter-log protection (the failed-statement limit is still open), certificate validation and pooler coverage (neither enforced yet).
- Supplier delivery of sign-in codes: design provisional.
- The staging CI diagnosis behind PR #9 stays labelled inferred. The single unexplained API test failure from slice 4 stays unresolved.
- Wording and translation corrections go to `FINAL_AUDIT_BACKLOG.md`.
