# Trucker: organisation verification slice 9, record

Date: 14 November 2026. Branch `feat/organisation-verification`, from staging at `074e068`. Scope and decisions: `ORGANISATION_VERIFICATION_SLICE_9_SCOPE.md` (VD-1 to VD-7, E-1 to E-4, VER-1 to VER-20).

Everything here is demonstration only. The evidence requirements are fictional, exist only for the fictional countries, and load only into databases marked for local development or tests. No real country's requirement is in the repository. Evidence entries are what the applicant typed: no file is held and nothing is checked against a register.

## 1. What was built

| Part | Where |
|---|---|
| Applications as numbered versions, evidence entries, capabilities, requirements, the publication check, and every function that submits, withdraws, decides or revokes | `db/migrations/0007_organisation_verification.sql` |
| Fictional requirements for the fictional countries XA and XB | `db/fixtures/local-development/countries.json` |
| Applicant routes under `/organisations/:id/verification` | `apps/api/src/verification/` |
| Staff routes under `/staff/verification` | `apps/api/src/staff/review.service.ts`, `staff.controller.ts` |
| Applicant page in English, Arabic and Urdu | `apps/web/src/app/[locale]/organisations/[id]/verification/` |
| Console: queue, application with decision, withdrawal | `apps/console/src/app/verification/` |

## 2. How it works

**Versions.** Each submission is a new numbered version holding the legal name, country, registration number and evidence entries as submitted. A version is never changed afterwards. One version can be open at a time. While it is open the organisation is locked; the applicant can withdraw it.

**Who decides (VD-1, VD-2, S-4).** One reviewer, through the staff functions only. The API's database role cannot write a decision, a capability or an organisation status. Before any decision the database asks whether the reviewer is independent: the participant-account declaration must be recorded, the declared number must not belong to the organisation's creator, any present or former member, or the submitter, and the reviewer must declare no connection for this decision. "Not declared" is never treated as independent. Each refusal is audited.

**Competing claims (VD-3, E-1).** If another verified organisation holds the same country and registration number (compared without case or spacing), "verify" does not verify. The application goes to claim review. The applicant is told only that it needs further review. The reviewer is shown only that a competing claim exists. Nothing happens to the other organisation. A claim review is decided by a different staff member holding both `staff_admin` and `reviewer`, who must also be independent. Verifications for one registration number are taken one at a time, so two cannot pass as routine at the same moment.

**Resubmission (VD-4).** After "changes requested" or "rejected" the applicant corrects and submits a new version. The page offers the previous entries so nothing is retyped. There is no limit on resubmissions.

**Amendments (VD-5, E-2).** A verified organisation's legal name, country and registration number change only through a reviewed amendment. The API refuses a direct change, and so does a database trigger for the API's role. Until an amendment is approved the approved identity stays in force with its rights. Other details stay editable.

**Withdrawing a verification (E-3).** A staff administrator who did not give the verification, who is independent and declares no connection, withdraws it with a reason. Status and capability change in one step, an open amendment is closed, history is kept, and nothing else of the organisation is touched. The applicant may apply again.

**Publication check (VD-7, E-4).** `organisation_may_publish()` answers yes only for a verified organisation holding the `ship` capability, and in a production database never when the capability rests on demonstration evidence. Nothing can be published in this slice; the check exists for the next one.

**Audit.** What the organisation may see is in its own history, marked as done by staff without naming anyone. Staff views, decisions and refusals are in the staff audit list.

## 3. Routine choices made during the build

- Legal identity means legal name, country and registration number.
- A withdrawn verification is its own organisation status, `verification_withdrawn`.
- The applicant learns the outcome on the page. No message is sent.
- Withdrawing a verification also requires independence and the no-connection declaration.
- A decision carries no retry key. As decided by Abdullah on 14 November 2026 (VER-15 adjusted in the scope): a decision sent again is the same request only when the staff member, the application version it was made against, the decision and the reason all match; then the first outcome is reported and nothing is changed or recorded. Anything else is refused. The note is not compared. The request that raised a competing claim is treated the same way. The version each decision and each claim was made against is stored for this.
- After a lost answer the console offers "Send the same decision again", carrying the version, decision and reason (not the note) and asking for the no-connection declaration again, since the first request may not have arrived.
- An administrator who is not a reviewer cannot open applications. The withdrawal form takes the organisation identifier, which the application page fills in and the audit entry of the view records.

## 4. Checks run (local, this commit)

| Check | Result |
|---|---|
| `npm run verify` | Passed |
| API tests | 229 passed, 0 failed, 1 marked todo (SEC-01, see `SECURITY_BACKLOG.md`); 19 new for verification, two of them for repeated decisions |
| Web unit tests, tool tests | 24 and 9 passed |
| Web browser checks | 1,213 checks, 0 failed; 16 verification checks plus layout, structure and accessibility rules on six verification states in three languages |
| Console browser checks | 184 checks, 0 failed; 14 verification checks and 3 for a lost decision answer (the decision commits, the answer is lost, the page says not confirmed, and sending it again confirms the first result with no new decision, capability change or audit entry, read directly from the database); queue, application, lost-decision and withdrawal pages inspected, keyboard included |
| Defect injection | Six defects put into the migration one at a time (independence skipped on decide and on revoke, claim raiser deciding, competing claim verified as routine, giver revoking, publication allowed in production). Each made at least one test fail. Then three more against the repeat rule (version not compared, reason not compared, no repeat path for a raised claim): each caught. Restored byte for byte |

Acceptance criteria: VER-1 to VER-18 and VER-20 are held by `apps/api/src/verification/verification.test.ts`; VER-13 and VER-19 by the browser checks.

## 5. Not verified, and limits

- A lost answer to a withdrawal (revocation) has no browser check. A repeated withdrawal by the same administrator with the same reason answers "already withdrawn"; the four-way match above applies to decisions only.

- Screen readers were not used. The automated rules cover only part of WCAG.
- Arabic and Urdu text is a draft without a native reader (final-audit backlog TR-10).
- The first administrator created by the operator command is "not declared" and cannot decide or withdraw until another administrator records the declaration. With a single administrator nobody can. This follows the independence rule and was kept as instructed; the console check shows the refusal and the way through with two staff.
- SEC-01 (two administrators removing each other at the same moment) is open, deferred, and must be closed before production or real staff use. Observed today: one removal succeeds and the other is aborted by the database's deadlock detector with a 500, leaving one administrator by accident rather than by rule. Both removals succeeding was not observed.
- Production gates from earlier slices are unchanged and still open.
