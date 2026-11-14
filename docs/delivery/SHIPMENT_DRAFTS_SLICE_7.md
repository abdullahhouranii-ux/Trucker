# Trucker: shipment draft-and-list slice 7, record

Date: 14 November 2026. Branch `feat/shipment-drafts`, from staging at `1d03e15`. Scope and decisions: `SHIPMENT_DRAFTS_SLICE_7_SCOPE.md` (approved with SD-1 to SD-5).

## 1. What was built

An administrator of a shipper organisation can save a private shipment draft, list drafts, change one and discard one, in English, Arabic and Urdu.

| Part | Where |
|---|---|
| Database: operating state of a country, time zones per country, lanes with ordered transit countries, drafts, retry keys, three protected settings, the functions that create, change, discard and list | `db/migrations/0005_shipment_drafts.sql` |
| Fictional countries, zones and lanes for local development and test only | `db/fixtures/local-development/countries.json` |
| API: `/organisations/:id/shipment-places`, `/shipments`, `/shipments/:id`, `/shipments/:id/discard`, `/shipments/:id/history` | `apps/api/src/shipment/` |
| Web: list, new draft, draft page with route, details, change form and discard | `apps/web/src/app/[locale]/organisations/[id]/shipments/` |

There is no route, screen or wording for publication, quotation, booking or payment. A test reads the shipment code and the route table to hold that.

## 2. How the approved conditions were met

**Stable pagination.** Order of creation, newest first, by a position the database assigns once. The cursor is the id of the last draft read and must belong to the selected organisation. Section 6 of the scope lists the guarantees; the test walks 45 drafts while two are changed, two added and two discarded, with time moved forward so that the changed drafts really are the latest changed.

**Lost answers.** Each create, change and discard carries a retry key kept in the form. The same key with the same content is answered as already applied and writes nothing more; with different content it is refused. A discard of a discarded draft is answered as already discarded with no new audit entry. When no answer arrives, the page says the outcome is not known and keeps the key, also across the "service did not answer" page, so the next attempt asks for the same thing.

**Conflicts.** A stale change is refused with the current draft. The person's typed input was kept in the browser against the version it was typed for; the page carries it over to the current version, shows the saved draft, and offers saving over it or dropping the changes.

**Ambiguous times.** A time that occurs twice is refused with both offsets, and the form then shows a choice with no option preselected. The choice is stored and shown again when the draft is reopened. A time that does not exist is refused. A time with no zone is kept as typed with no moment stored.

**Weight and pieces.** Kilograms, greater than 0, at most 100,000, three decimals at most. Whole pieces, 1 to 100,000. Checked in the API and again by the table's own constraints.

## 3. Database access

The API's role may read drafts of the organisation the request selected and nothing else, and may write no draft, retry key or audit entry directly. Six functions are callable by it: `route_check`, `offset_choices`, `create_shipment_draft`, `update_shipment_draft`, `discard_shipment_draft`, `list_shipment_drafts`. None takes a time, a limit or a page size. Limits, page size, key retention and the clock are the database's.

`offset_choices` was added during the web work: the form needs to know that a stored time occurs twice in order to show the choice again. It takes a draft id, answers only for the selected organisation's drafts, and is tested as the API role with another organisation selected.

## 4. Checks run (local, this commit)

| Check | Result |
|---|---|
| `npm run verify` (format, lint, typecheck, migration check, tests) | Passed |
| API tests | 188 passed, 0 failed (166 before this slice; 22 new for shipments) |
| Web unit tests | 24 passed |
| Tool tests | 9 passed |
| Browser checks, real Chrome against the real API and PostgreSQL | 1,024 checks, 0 failed. 75 are shipment-specific; the layout, structure and accessibility-rule checks also cover 8 shipment screen states in each of 3 languages |

CI results are in the pull request, not here.

### Defect injection

Each change was made to the migration, the shipment tests were run, and the migration was restored (verified identical afterwards).

| Injected defect | Caught by |
|---|---|
| A change ignores the version | "a change needs the version it was made against" |
| A discard ignores the version | "discard keeps the record and its history, checks the version, and happens once" |
| A repeated discard is not recognised | the same test |
| The list is ordered by last change | "pages stay stable while drafts are changed, discarded and added" |
| An ambiguous time silently takes the earlier moment | "a time that occurs twice must be chosen" |
| `offset_choices` ignores the organisation | the same test |

The ordering defect was **not** caught at first: the test clock stood still, so every draft had the same change time and the wrong order looked right. The test now moves time forward before and after the changes. This was a gap in my test, found by this check.

## 5. Screens reviewed and defects fixed

Five pictures were taken for review (`apps/web/tests/output/`, not committed): new draft with errors (English), draft page (Arabic), conflict (Urdu), ambiguous time (English), list (Arabic).

| Defect found on the real screen | Fix |
|---|---|
| Date and time boxes forced the page sideways with text doubled | The pair now stacks when there is no room |
| Example values shown as placeholders looked like filled-in times | Placeholders removed; the examples are in the hint |
| In Arabic and Urdu the example date in the hint broke across lines out of order | Examples are now left-to-right islands that do not split |
| The filter in use (open or discarded) looked the same as the other | Filled and underlined, and marked for assistive technology |
| Created and changed times ran together on one wrapped line | One per line |

## 6. Known limits

1. **Keeping typed input needs scripts.** With scripts disabled, input is lost on a refusal, a language change or a conflict. Same limit as earlier slices (AX-04).
2. **Saving over a colleague's change saves every field of the form,** including fields the person did not touch, which then return to the values they started from. The page says so. Field-by-field merging is not built.
3. **If a colleague discards the draft while someone is typing,** the change is refused and the typed input cannot be saved anywhere.
4. **The time-zone list is grouped by country but not filtered by the chosen country.** A zone of another country is refused by the server with a clear message.
5. **Dates and times are typed as text** (year-month-day, 24-hour clock). No date picker; device testing should decide.
6. **A draft's stored moments are not recomputed** if the time-zone rules of a place change later. No decision exists on that.
7. **Clock-change behaviour was checked with a real zone attached to a fictional country** in the tests, because the fixtures have fixed-offset zones only.
8. The header still shows "Sign in" to a signed-in person (WD-04, earlier slices). `docs/delivery/STATUS.md` is out of date from earlier slices and was not touched here.
9. No screen reader, physical phone, Safari or Firefox test. No accessibility conformance is claimed.

## 7. Carried forward, unchanged

- Production gates: encrypted database connection; parameter-log protection, with the failed-statement limit still open; certificate validation and pooler coverage, not enforced.
- Supplier delivery of sign-in codes: provisional.
- The staging CI diagnosis behind PR #9: inferred, not verified. The slice-4 unexplained failure: unresolved.
- SD-5: 200 open drafts and 20 per page are development defaults and need review before production. So does the 24-hour retry-key retention.

## 8. Needs Abdullah

1. Review and merge decision for the pull request. Nothing is merged or deployed.
2. Whether limit 2 (save-over replaces every field) is acceptable for drafts, or field-by-field merging should be scoped.
3. Whether a recently changed draft should be findable another way (for example a separate "recently changed" view), since the list deliberately does not reorder.
