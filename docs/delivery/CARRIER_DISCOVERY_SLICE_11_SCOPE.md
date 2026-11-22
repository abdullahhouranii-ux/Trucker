# Trucker: carrier onboarding and discovery slice 11, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **approved by Abdullah on 15 November 2026, with CB-1 to CB-8 as recommended and the clarifications in section 5a.** Record of what was built: `CARRIER_DISCOVERY_SLICE_11.md`. Sources: `docs/specs/STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md` (capabilities, sections 2 and J1.2–J1.3), `docs/specs/STAGE_2_PART_2_PUBLICATION_QUOTATION_BOOKING.md` section 5 (journey J3, AT-211), Stage 1 baseline (J3, O2), the decision update of 14 November 2026 (D-001 decided: agent), and slices 9 and 10 as built (slice 10 on PR #14). Repository copy: `docs/delivery/CARRIER_DISCOVERY_SLICE_11_SCOPE.md`.

## 1. What this slice is

One user journey, end to end, on test accounts and fictional data:

1. **Carrier onboarding.** An administrator of an organisation applies for the carrier capability through slice 9's verification flow (demonstration evidence only). The application declares where the carrier operates and which equipment types it offers. Staff decide it as in slice 9. Withdrawal, revocation and changes requested behave as in slice 9.
2. **Discovery.** An administrator of a verified carrier organisation sees a list of published shipments it is eligible for, and opens one. What it sees is exactly slice 10's carrier projection (PB-4), never the shipper's identity, addresses, access notes, reference or contacts. A suspended, withdrawn or expired shipment is not shown. Eligibility is checked by the database at every read.

Production stays closed by the same gates as slice 10: no lanes, no catalogues, and demonstration evidence only.

## 2. Out of this slice

The following are not in this slice:
- quotations, prices, currencies and fees;
- counter-offers, acceptance, booking and reservations;
- the vehicle-owner capability (`offer_owned_vehicles`, unless CB-1 says otherwise);
- trucks, trailers and drivers as verified assets, and driver affiliation;
- dispatcher and other member roles (only `admin` exists);
- notifications to carriers or shippers, matching or alerts, and saved searches;
- invited-carrier lists (C-41) and return loads (C-18);
- partner API access and native applications;
- real evidence requirements (E-4), and every production gate in `SECURITY_BACKLOG.md`.

## 3. How it works

| Topic | Proposal |
|---|---|
| Capability | `carry_as_company` (Part 1, section 2), added beside `ship`. Its own application, state and history; deciding or revoking one capability never changes the other (subject to CB-2) |
| Onboarding | The organisation and verification records from slices 5 and 9 are reused, with no second registration. The application names the capability; the evidence catalogue for it is fictional and loads only into marked databases, like slice 9's |
| Declared service | The carrier application carries the countries it serves and the equipment types it offers, from slice 10's catalogues. These are **declared, not verified**, and are labelled so to the carrier, to staff, and in code (CB-3) |
| Changing what is declared | A change after verification is a new application version that staff decide, as in slice 9. Discovery uses only the decided version (CB-4) |
| Eligibility | All of the following, judged by the database after its locks at every read: the organisation is verified for `carry_as_company`, the capability was not granted on demonstration evidence in a production-marked database, and the route is open. The shipment must also be published and not suspended (PB-5), and not expired by the database clock. Its pick-up and delivery countries, and its equipment type, must be among those decided for the carrier (CB-3) |
| Own shipments | An organisation that holds both capabilities never discovers its own shipments (CB-2) |
| What is shown | The carrier projection from slice 10, of the latest published version only, with the quotation deadline and windows in each place's own named time zone. The shipper is shown only as "verified shipper", as in the preview, and the PB-4 caution about free text stays true: anonymity is not guaranteed (CB-5) |
| Losing eligibility | A shipment that becomes suspended, expired or withdrawn, or a carrier whose verification is withdrawn or revoked, disappears from the list. Opening the shipment then answers exactly like one that does not exist, at the next request. Nothing is cached |
| List | Sorted by quotation deadline, soonest first, with keyset pagination. Filters for pick-up country, delivery country and equipment type. Page size and a read-rate limit are protected settings with development defaults that need production review (routine) |
| Who | Administrators of the carrier organisation (CB-6) |
| Records | Carrier reads are recorded as described in CB-7. Staff views of carrier applications are audited as in slice 9 |
| Staff console | Carrier applications appear in slice 9's queue, labelled by capability, with the declared service shown and marked "declared" |
| Shipper side | Unchanged, except that any statement on the preview that no carrier can see the shipment yet becomes untrue and is corrected. This is a correctness change, not a wording change; other wording stays with the final audit |

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| CAR-1 | An organisation can apply for `carry_as_company` with declared countries and equipment types. Every problem is reported by field, in three languages. Retries, lost answers and stale versions behave as in slice 9 |
| CAR-2 | Staff decide, request changes on, reject and revoke a carrier application exactly as in slice 9. Each transition is audited once, and the `ship` capability is unaffected (subject to CB-2) |
| CAR-3 | Only countries and equipment types that exist in the database's catalogues can be declared. After the migrations none exist; fictional entries load only into marked databases |
| CAR-4 | A discovering organisation sees a shipment only when every eligibility condition in section 3 holds at the moment of the read (AT-211). Each condition is tested on its own, as the API's database role |
| CAR-5 | An ineligible organisation, an unverified one, one whose capability was revoked or withdrawn, and the shipper itself all get the same answer for a shipment as for one that does not exist |
| CAR-6 | The carrier view contains exactly the slice 10 projection fields of the latest version. A test fails if any address, access note, shipper reference, shipper name, registration number, person or contact detail appears, including through filters, sorting, error details and pagination cursors |
| CAR-7 | A shipment that is suspended, withdrawn or expired by the database clock, including one whose expiry has not yet been recorded, never appears in a list or detail. A request that waited behind a lock while the deadline passed does not return it |
| CAR-8 | Concurrent tests cover verification withdrawal, shipment suspension, withdrawal and expiry during discovery. Each read gives one consistent answer, with no server errors and nothing recorded twice |
| CAR-9 | The API's database role cannot read the shipment table, the publication versions or carrier declarations except through the discovery functions; this is tested as that role. The hardening lists are regenerated |
| CAR-10 | Windows and deadlines are shown in each place's own named time zone for viewers in other zones (AT-204) |
| CAR-11 | Carrier screens work in English, Arabic and Urdu at phone widths and with text doubled. Console screens pass the same automated checks. A lost answer to a carrier application is checked in the browser |
| CAR-12 | No quotation, price, fee, booking, payment or contact route, field, word or screen is added |
| CAR-13 | Paging is stable under concurrent publication and expiry, with no duplicates or skips within one snapshot of the ordering key. The page size and read limit are enforced by the database |

## 5. Decisions (approved 15 November 2026, as recommended)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| CB-1 | Which carrier capability this slice covers | (a) `carry_as_company` only; (b) also `offer_owned_vehicles` for independent owners | **(a).** Part 1 gives owners different limits that depend on verified assets, which do not exist yet. Owners come with the asset slice |
| CB-2 | Can one organisation hold both `ship` and `carry_as_company`? | (a) yes, separately verified, never discovering its own shipments; (b) no, one capability per organisation | **(a).** Part 1 says an organisation holds capabilities, not a single type, and many regional carriers also ship. Revoking one never changes the other |
| CB-3 | What eligibility is matched against before verified assets exist | (a) declared countries and equipment types, decided by staff and labelled "declared"; (b) no matching, so every verified carrier sees every published shipment; (c) wait for verified trucks | **(a).** It limits what each carrier sees to work it says it can do, and (c) would delay discovery behind the asset slice. Geography matches when both the pick-up and the delivery country are declared. Per-lane declaration waits until lanes are decided (D-003c) |
| CB-4 | Does changing declared service need a new staff decision? | (a) yes, a new application version, and discovery uses the last decided version; (b) the carrier edits freely | **(a).** Otherwise the declaration that limits visibility is self-service and means little |
| CB-5 | What a carrier sees | (a) exactly the slice 10 projection of the latest version; (b) also earlier versions; (c) also the shipper's name | **(a).** It matches PB-4 as approved. Earlier versions matter once quotations must be re-confirmed (AT-203), which is a later slice. Showing the shipper's identity would reverse PB-4 |
| CB-6 | Who in a carrier organisation may discover | (a) administrators only, for now; (b) wait for member roles | **(a).** Only `admin` exists. `dispatcher` comes with the membership slice |
| CB-7 | Are carrier reads recorded, and does the shipper learn who looked? | (a) a staff-only access log of carrier reads (who, which shipment, when), with no shipper-facing "viewed by"; (b) no record; (c) shipper sees viewers | **(a).** It gives evidence if projection data is misused, at low cost. Telling shippers who looked is a product and privacy choice for later, and not needed for J3 |
| CB-8 | Carrier evidence in this slice | (a) fictional catalogue and demonstration evidence only, never allowing production discovery; (b) wait for real requirements (E-4) | **(a)**, mirroring slice 9 and PB-2. Real requirements stay with E-4 and block production |

### 5a. Clarifications given with the approval

- Shipper and carrier capability decisions stay independent. A shared legal-identity amendment must not silently change the identity underlying either approval; how both capabilities are revalidated is defined and tested (record, section 2).
- Only the approved carrier projection. Eligibility is enforced on every list and detail request, including cursor reuse, filters and requests delayed past expiry or revocation. Cached pages must not bypass authorization.
- Pagination: snapshot and cursor rules are defined explicitly. Live eligibility is always rechecked: a withdrawn or newly ineligible shipment disappears even if it was in the original snapshot. Deadline changes between pages are tested.
- Access logs are staff-only and append-only, without copying shipment descriptions, addresses or contact details. Retention is recorded as an unresolved production requirement.
- Test accounts and fictional evidence only. Declarations establish matching criteria, not verified vehicle availability or permission to accept work.

The approved scope of slice 10 already decides the rest: PB-1 (no carrier access before this slice), PB-4 (field allowlist, hidden identity, anonymity never claimed) and PB-5 (suspension blocks discovery).

## 6. Decisions that block production use, not this build

These are already open in the register; this slice does not decide or work around them.

| ID | Decision | Why it blocks production discovery |
|---|---|---|
| D-003c, D-003b | First lanes and enabled countries. **Undecided.** The target stays the Middle East with GCC priority; no country or lane is chosen here | No lane is open in production, so nothing is published or discoverable |
| D-006 | Real cargo and equipment catalogue | Catalogues are empty in production |
| E-4 | Real evidence for `ship` and `carry_as_company` | Demonstration evidence never allows production discovery |
| SEC-01 | Concurrent administrator removal | Blocks real staff use, so no carrier can be verified |
| Terms | Approved legal terms, including carrier terms of use for projection data | Production registration is closed |
| Production settings | Discovery page size and read limit, with the other development defaults | Development defaults need production review |

## 7. Routine choices (made during the build, reported, not asked)

Storage layout, function and route names, how declared service is stored, page and filter layout, cursor format, the access-log shape, default page size and read limit for development, test design, and the console labels.

## 8. Carried forward, unchanged

- All production gates in `SECURITY_BACKLOG.md`.
- SEC-01 open and deferred.
- The staging CI diagnosis behind PR #9 stays "inferred".
- The slice-4 unexplained API test failure is unresolved.
- Development-default settings need production review.
- Test accounts and fictional data only.
- Wording and translation corrections go to the final-audit backlog.
