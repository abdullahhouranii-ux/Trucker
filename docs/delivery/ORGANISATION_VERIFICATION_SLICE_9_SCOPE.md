# Trucker: organisation verification slice 9, scope and acceptance criteria

Version 1.0, 14 November 2026. Status: **approved by Abdullah on 14 November 2026** (two-slice scope, VD-1 to VD-7, E-1 to E-4, S-4). Not built. It starts after slice 8 (staff identity, PR #12) is merged and staging CI is green. This document will be committed as `docs/delivery/ORGANISATION_VERIFICATION_SLICE_9_SCOPE.md` with the slice.

## 1. What this slice is

An administrator of an organisation submits it for verification with evidence entries. A reviewer decides in the staff console. The applicant sees the outcome and can correct and resubmit. Nothing is published.

## 2. Decisions

| ID | Decision |
|---|---|
| VD-1 | One independent reviewer decides a routine verification |
| VD-2 | A reviewer cannot decide an application they created or belong to |
| VD-3 | Competing registration claims go to a separate review. The other organisation is not exposed and is not restricted automatically |
| VD-4 | A rejected applicant may correct and resubmit as a new application version. Earlier decisions are preserved |
| VD-5 | A change to verified legal identity requires a new review |
| VD-6 | Fictional evidence requirements and demonstration wording only, until real requirements are approved |
| VD-7 | Manual evidence entries are never presented as document verification and never enable production publication |
| S-4 | Independence rests on declared participant links plus a conflict declaration at each decision. Missing linkage information never means independent |
| E-1 | A competing claim is decided by a different, independent staff member holding both administrator and reviewer privileges |
| E-2 | During an amendment review the previously approved identity stays active. Proposed details are kept separate and acquire no rights before approval |
| E-3 | A different staff administrator may withdraw a mistaken verification, with a reason. The capability is revoked atomically, history is preserved, new commercial actions are blocked, existing work is not cancelled automatically |
| E-4 | Evidence entries only, clearly labelled declared and demonstration-only. No files. No production publication based on them |

## 3. How the decisions are applied

**Application versions.** Each submission is a numbered version holding a copy of the organisation's legal identity (legal name, country, registration number) and its evidence entries as submitted. A version is never changed after submission. One version at a time can be open.

**States of an organisation.** `draft` → `submitted` → `verified`, `changes_requested` or `rejected`. From `changes_requested` and `rejected` the applicant edits and submits a new version. A submitted version can be withdrawn by the applicant, returning to the state before it. A verification withdrawn by staff (E-3) gives `verification_withdrawn`, from which the applicant may submit again.

**Legal identity (VD-5, E-2).** Legal name, country and registration number. While verified they cannot be edited directly. An amendment is a new application version that proposes new values. The organisation stays verified under the old values until a reviewer approves, when the new values replace the old ones in one step. A rejected amendment changes nothing. Other details (trading name, address, contact person) can be changed without review, and are audited.

**Evidence entries (VD-6, VD-7, E-4).** Document type, number, issuing country, issue date, expiry date, typed by the applicant. Document types and which are required come from a register by country and capability. The register is empty after the migrations; fictional requirements load only into databases marked local-development or test. Every screen showing entries, to applicant and reviewer, says they are declared by the applicant, not verified documents, and demonstration-only.

**Reviewer independence (VD-2, S-4).** The database refuses a decision unless all of these hold, and records each refusal:

1. the reviewer's participant link is declared, either "none" or a mobile number. "Not declared" is refused;
2. if a number is declared, the participant with that number did not create the organisation, is not and was not a member of it, and did not submit the application;
3. the reviewer confirms, at this decision, that they have no connection with the organisation. The confirmation is stored with the decision.

Stated limit: a connection nobody declared cannot be detected.

**Competing claims (VD-3, E-1).** If the same country and registration number is already verified for another organisation, a routine decision to verify is not possible. The attempt moves the application to claim review and records who raised it. The applicant is told only that the application needs further review. The other organisation sees nothing and nothing about it changes. A claim review is decided by a staff member who holds both `staff_admin` and `reviewer`, is independent by the rules above, and is not the person who raised it. The outcome is verified or rejected for the applicant only.

**Capability.** `ship` is granted by a verified decision and by nothing else, recorded with its basis, which is "demonstration evidence". A server-side check answers whether an organisation may publish. It answers yes only for verified with `ship`, and in a production database never for a capability granted on demonstration evidence. No publication is built.

**Withdrawing a verification (E-3).** A `staff_admin` who is not the reviewer who gave it withdraws it with a reason. In one transaction the organisation becomes `verification_withdrawn` and the capability is revoked. Every version, entry and decision stays. The publication check answers no from that moment. Nothing else is cancelled.

**Reasons.** Each decision carries a reason from a fixed list and an optional note. The list and its wording are demonstration text.

## 4. In

1. Applicant, in English, Arabic and Urdu: submit with declaration of authority; add, change and remove evidence entries before submitting; withdraw; see status, reason, next step and earlier versions; propose an identity amendment when verified.
2. Console, for `reviewer`: queue of submitted applications and claim reviews; one application with identity, entries, earlier versions and decisions; decide with reason, note and conflict confirmation.
3. Console, for `staff_admin`: withdraw a verification.
4. Database functions for every step, with locks, the database's clock, retry keys and version checks, callable only as designed; audit entries for submission, withdrawal, staff views and decisions.
5. The publication check.

## 5. Out

| Out | Reason |
|---|---|
| Evidence files, storage, scanning, retention | D-011 undecided; a paid service (E-4) |
| Any real country's requirements; any claim that documents were checked | No approved legal requirement |
| Suspension, expiry, renewal reminders | Lead times and authority undecided |
| Appeal after rejection, beyond resubmission | Not decided |
| Vehicle, driver and ownership verification | Separate subjects |
| Notifications by message or email | No supplier |
| Publication, quotations, booking, payment | Later slices |

## 6. Acceptance criteria

| ID | Criterion |
|---|---|
| VER-1 | Only an administrator of the organisation can submit, only when no version is open, and only with the declaration given |
| VER-2 | Each submission is a new numbered version. Earlier versions, entries and decisions are never changed |
| VER-3 | A submitted version cannot be changed by the applicant through the API, the database role or the pages. It can be withdrawn |
| VER-4 | Only a staff session with `reviewer` can decide. No participant path can, and the API's role cannot outside the staff functions |
| VER-5 | A reviewer who is not declared, who is linked to the creator, a member or the submitter, or who does not confirm no connection, is refused by the database and the refusal is audited |
| VER-6 | A version is decided once. Two reviewers deciding at the same moment produce one decision |
| VER-7 | A competing claim cannot be verified as routine. Messages and the API reveal nothing about another organisation, and the other organisation is unchanged |
| VER-8 | A claim review is decided only by a different, independent staff member holding both privileges |
| VER-9 | `ship` is granted by a verified decision only, with its basis recorded |
| VER-10 | The publication check answers yes only for verified with `ship`, and in a production database never on demonstration evidence |
| VER-11 | A verified organisation's legal identity cannot change except through an approved amendment. Until then the approved identity is the active one, and a rejected amendment changes nothing |
| VER-12 | A verification can be withdrawn only by a staff administrator who did not give it. Status and capability change together; history is intact |
| VER-13 | Evidence entries are labelled as declared, not verified, and demonstration-only on every screen that shows them, in three languages |
| VER-14 | After the migrations no requirement exists and nothing can be verified. Fixtures load only into marked databases |
| VER-15 | Submission and withdrawal carry retry keys and version checks. Decisions carry a version check and no retry key (adjusted 14 November 2026, see below). A lost answer is reported as not confirmed and a retry applies nothing twice |
| VER-16 | Decisions use the database's clock after any lock wait. An ended staff or participant session changes nothing |
| VER-17 | Another organisation's applications answer exactly like ones that do not exist |
| VER-18 | Every submission, withdrawal, staff view and decision leaves one audit entry |
| VER-19 | Applicant screens work in English, Arabic and Urdu at phone widths and with text doubled. Console screens pass the same automated checks in English |
| VER-20 | No publication, quotation, booking or payment route, word or screen is added |

**Adjustment to VER-15 (Abdullah, 14 November 2026).** A staff decision is sent again without a retry key. It is accepted as the same request, and answered with the first outcome, only when the staff member, the application version it was made against, the decision and the reason all match. Any request that differs in one of them is refused, and nothing is changed or recorded. The note is not compared; the note recorded first stands. The same holds for the request that raised a competing claim, which is answered "claim review" again. Tested in `apps/api/src/verification/verification.test.ts` and, for a lost answer in the console, in `apps/console/tests/browser.mjs`.

## 7. Routine choices already made (not decisions for you)

- Legal identity means legal name, country and registration number. Trading name, address and contact person can change without review.
- A verification withdrawn by staff has its own state, `verification_withdrawn`, so that it is not confused with a reviewer asking for changes.
- No limit on the number of resubmissions, other than one open version at a time.
- The applicant learns of a decision by opening the organisation page. There is no message.

## 8. One thing to settle before this slice is merged

A reviewer must have their participant link declared, and nobody may record that for themselves. So the first administrator, made by the operator command, cannot review until a second administrator records their declaration. If you intend to be the only staff member for a time, a different rule is needed for a sole administrator. Recommended: keep the rule and create a second administrator, which the withdrawal and claim-review rules need in any case.

## 9. Carried forward, unchanged

- Production gates: encrypted database connection; parameter-log protection, failed-statement limit open; certificate validation and pooler coverage, not enforced; console network restriction and content policy.
- Supplier delivery of participant sign-in codes: provisional.
- Staging CI diagnosis behind PR #9: inferred. Slice-4 unexplained failure: unresolved.
- Development defaults needing production review: SD-5 limits, retry-key retention, staff settings.
- Wording and translation corrections: final-audit backlog.
