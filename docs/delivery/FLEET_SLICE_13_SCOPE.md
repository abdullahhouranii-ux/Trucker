# Trucker: fleet and drivers slice 13, scope and acceptance criteria

Version 1.0, 15 November 2026. Status: **approved for development by Abdullah on 15 November 2026, with DB-4, DB-5 and FB-1 to FB-5, and the conditions in section 0.** Built on branch `feat/fleet` (record: FLEET_SLICE_13.md). First of the essential missing slices in RELEASE_1_GAP_TO_LAUNCH.md (step 13).

Sources:
- `docs/specs/STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md`: section 3 (ownership, affiliation, authorisation, operating controller, stop causes) and J1.3 to J1.5;
- Part 2, section 7 (what booking checks);
- slices 9 and 11 (verification, the carrier capability).

No document requirement, licence class or legal rule is chosen here. Wherever one is needed, it is a decision, and the build uses fictional values until it is made.

## 0. Approval and conditions

Approved for development: company carriers only, one active carrier affiliation per driver, driver-accepted invitations, fictional document and class registers, and the proposed development limits.

| ID | Condition |
|---|---|
| FC-1 | Ownership claims, operating control, document approval and availability stay separate |
| FC-2 | A first registration claim is not proof of ownership |
| FC-3 | A conflicting claim reveals nothing to either carrier and does not automatically restrict the existing carrier. This replaces the "refused" answer first proposed in FB-4: the second claim is recorded, shown to staff only, and only one claim on a registration can be verified |
| FC-4 | A carrier's access to a driver's documents ends with the affiliation, subject to approved retention |

## 1. What this slice is

A verified carrier records its **trucks**, **trailers** and **drivers**, so that the booking slices can later assign only resources that are eligible at that moment.

- **Vehicles.** The carrier claims ownership of a truck or trailer with its registration details and documents. Staff with the reviewer privilege verify it.
- **Drivers.** A driver is a registered person. The carrier invites the driver to affiliate; the driver accepts in their own account. The driver's licence and other documents are verified by staff.
- **Authorisation.** The carrier authorises each driver for a single vehicle or for all of its vehicles (Part 1, 3.4).
- **Eligibility.** Eligibility is judged live by one database function over a time window. For a vehicle it covers ownership verified, every required document accepted and valid through the window, the carrier capability effective, and equipment compatible with a shipment. For a driver it covers affiliation active, licence verified and valid through the window, the licence class covering the vehicle, and an authorisation covering the vehicle. Slice 15 calls this function inside its own locks. The function decides nothing about availability.
- **Expiry.** Document expiry is judged by the database clock and needs no worker, as for quotations.

Nothing is reserved, assigned, dispatched or booked in this slice.

## 2. Out of this slice

The following are not in this slice:
- reservations, assignment, driver acknowledgement and dispatch (slices 15 and 17);
- delegated management and the vehicle-owner capability (`offer_owned_vehicles`) (DB-5 recommends carriers only for Release 1);
- the ownership-dispute process of Part 1, 3.8, beyond FB-4;
- intervention cases for the stop causes in Part 1, 3.7 (with operations, slice 17);
- document file upload: numbers, dates and issuing country only, as in slice 9, until file storage is chosen (X-7);
- GPS devices (C-10), telematics and maintenance records.

## 3. How it works

| Topic | Proposal |
|---|---|
| Who manages the fleet | Administrators of an organisation with an effective `carry_as_company` capability. Every check is repeated in the database function, after its locks |
| Vehicle record | Kind (truck or trailer); equipment type from the slice 10 catalogue; registration country and number, unique per country among active claims; vehicle category for licence matching (FB-3); documents |
| Driver record | A link to an existing person, with affiliation states `invited` → `active` → `ended`; documents; licence classes as stated on the verified licence |
| Documents | Type from a register per country and subject kind (fictional in development, FB-1). States: number, issuing country, issue and expiry dates, `submitted` → `accepted` / `rejected`. A new version replaces an old one only when accepted |
| Staff decisions | The reviewer privilege, with the no-conflict declaration and audit of slice 9. A decision records its reason code |
| Eligibility | One function, `resource_eligible(resource, from, until)`, returns `eligible` or the first failing reason code. It reads under share locks and uses the database clock |
| Withdrawal | The carrier ends an affiliation or authorisation, or retires a vehicle. Staff can suspend a resource with a reason. Each takes effect at the next eligibility check |
| Privacy | Driver documents are visible to the driver, the affiliated carrier's administrators and staff. A shipper sees nothing in this slice; slice 15 decides the assignment view (DB-6) |
| History | One audit entry per transition, each exactly once. Retries are handled as in earlier slices |

## 4. Acceptance criteria

| ID | Criterion |
|---|---|
| FLT-1 | Only an administrator of an organisation with an effective carrier capability can register or change vehicles and invite drivers. Anyone else is refused exactly as for a missing record |
| FLT-2 | A carrier holds one active record per registration. Another carrier's claim on the same registration is recorded without disclosing the first, changes nothing for the existing carrier, and only one claim per registration can be verified, including under simultaneous decisions (FC-2, FC-3) |
| FLT-3 | A driver's affiliation becomes active only through the driver's own acceptance. Under DB-5 a second active affiliation is refused, including under simultaneous requests |
| FLT-4 | A vehicle or driver is eligible only while every required document is accepted and its expiry is after the end of the window asked about. Expiry one second inside the window makes it ineligible, judged by the database clock |
| FLT-5 | An authorisation is required for a driver–vehicle pair, and the licence class must cover the vehicle category. Ending the affiliation ends eligibility at the next check |
| FLT-6 | Revoking the carrier capability makes every resource of that carrier ineligible at the next check, without editing the resources |
| FLT-7 | Staff decisions need the reviewer privilege, cannot be made on one's own organisation's resources, and are audited. The API role reaches the new tables only through functions, and the hardening lists are regenerated |
| FLT-8 | No other organisation can read any part of a vehicle, driver or document, including through errors and counts |
| FLT-9 | Screens in EN, AR and UR pass the existing browser checks at phone widths with text doubled. A lost answer is checked for vehicle registration and driver invitation |
| FLT-10 | No reservation, assignment, availability or booking field, route or wording is added |

## 5. Decisions for this slice (with recommendations)

The cross-release decisions are numbered DB-n in the gap plan. Those specific to this slice are FB-n.

| ID | Decision | Recommendation |
|---|---|---|
| DB-4 | What makes a resource eligible | As recommended in the gap plan. The build uses fictional document types until real ones are given |
| DB-5 | One affiliation per driver; carriers only | As recommended in the gap plan |
| FB-1 | Document register per country and subject (truck, trailer, driver) | Empty in production and fictional in development, as for evidence requirements. The real list is yours, with advisers (X-5) |
| FB-2 | How a driver joins | The driver registers with a mobile number like any person (slice 4), then accepts the carrier's invitation. No accounts are created on the driver's behalf | 
| FB-3 | Vehicle categories and licence classes | A register per country, mapping each licence class to the vehicle categories it covers. Fictional in development; the real mapping is yours, with advisers |
| FB-4 | A registration number already claimed by another carrier | As approved with FC-3: recorded as a claim, shown to staff only, with no automatic change and nothing disclosed. The full ownership-claim process (Part 1, 3.8) is deferred until after Release 1 |
| FB-5 | Development limits (protected settings, development defaults only) | Vehicles per carrier 200, drivers per carrier 200, document versions per document 5 |

## 6. Carried forward, unchanged

- PRs #15 to #18 stay unmerged until a focused dependency review and explicit authorisation.
- Test accounts and fictional data only.
- Wording and translation corrections go to the final-audit backlog.
- Production gates in `SECURITY_BACKLOG.md` remain open.
