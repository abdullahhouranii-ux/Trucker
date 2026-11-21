# Slice 18c — booking disputes and settlement holds

Implemented by Codex locally on 19-20 November 2026 (unreviewed branch `codex/unified-experience-mobile`) and split into its own branch, `feat/disputes`, on 21 November 2026, stacked on `fix/pod-unknown-outcome`. The migrations were renumbered from 0033-0035 to 0034-0036 when split. Migration 0034 extends the settlement hold table introduced by slice 18d. Migration 0035 records the booking financial settings version and adds immutable references to a trip milestone or related dispute. It keeps booking disputes outside the 18d cargo projection. The booking is held while any of its cause-specific holds is active. A booking dispute with a specified amount or item places its own hold. A financial claim with no identified scope records scope under review. A non-financial claim places none. Cargo interventions retain their own holds and permissions.

## Implemented locally

- A booking administrator for either contracting organisation can open, reply and act for that organisation. Operations can open on a contracting party's behalf with a recorded reason, assign an operations owner, request information, add internal notes, propose terms, or close without agreement. Participants see the shared timeline and evidence. Other existing booking roles do not inherit dispute authority.
- Proposals and responses are immutable. The latest proposal needs explicit acceptance by both contracting organisations. An agreement references its accepted terms for later processing. Neither proposals nor the record of agreement execute payment, change booking prices, issue refunds, or change trip resources or custody. An external report records the supplied authority reference and basis.
- A staff administrator can release the owning hold after explicit agreement or withdrawal without a counterclaim, with a reason. An administrative closure, silence, or an external report on its own leaves holds in place. Cargo commands cannot release these holds. Withdrawals preserve the history of any counterclaim.
- Commands are serialized for a booking and check the live session and authority again after locking. A retry with the same body returns the same receipt, and a reused key with different content conflicts. Proof of delivery is linked by immutable version. Shared attachments reuse the private file store, the POD media types and 10 MiB limit. The byte fingerprint checks integrity. Staff reads of attachments are audited.
- Party booking pages use English, Arabic and Urdu. The operations console has a booking detail panel and queue filters for owner and state. A lost response offers timeline verification and a retry with the original key and payload.

## Approved manual release rule

Abdullah approved this rule on 19 November 2026. A staff administrator may manually release the hold owned by the specific dispute after recording a reason and either explicit acceptance by both contracting organisations of the same proposal version, or withdrawal with no counterclaim. Administrative closure, a counterclaim, and an external decision leave the hold active. Release rules for administrative closure and external decisions require a separate decision. Abdullah approved explicit counterclaim terms on 20 November 2026. Migration 0036 requires the accepted proposal to record settlement terms for the counterclaims and to be sent after the latest recorded counterclaim. If a newer counterclaim arrives, staff can submit a revised proposal for both parties to accept. Previously recorded agreements without adequate terms keep their holds.

## Development defaults and remaining work

The types, authorised party administrators and staff privileges are development defaults. Approved dispute policy versions, permitted delegated actions, opening and response windows, reminders, overdue filters, limits, escalation, external release authority, evidence retention and the settlement processor need implementation and approval before production. The existing driver incident and POD journeys can capture facts. The dispute panel supports POD version links and separate uploads. A production process for counterclaims remaining after withdrawal and native dispute screens remain outstanding. No expiry rule accepts a proposal, waives a claim, or lifts a hold.

## Verification on the split branch (21 November 2026)

Run on Node 24 with isolated PostgreSQL, on this branch alone.

| Check | Result |
| --- | --- |
| `npm run verify` | API 424 pass, 0 fail, 1 skipped (the browser journey, which runs only with `TRUCKER_DISPUTE_BROWSER=1`); web 24/24; console 9/9 |
| Dispute browser journey (`TRUCKER_DISPUTE_BROWSER=1`) | Passes: shipper, operations and carrier reach a mediated agreement, release, outsider refused |
| Web browser suite | All checks pass |
| Console browser suite | All checks pass |
| Deliberate faults in `0036` | Six, one at a time, all caught: release after closure or an external decision, release after a withdrawal with a counterclaim, agreement on different proposal versions, no trip lock, release by operations without `staff_admin`, release of an agreement that does not cover counterclaims. The last was missed at first; a check with an agreement recorded under the earlier rules now catches it |

Changes made while splitting:

- The lock-wait check in the revoked-administrator test read other sessions' query text, which works only when the test role is a superuser. It now uses the same check as the other lock tests (an ungranted lock in this database). It detects the same wait.
- The browser journey also exercised slice 19 (financial completion). Those steps belong to slice 19 and were removed from this branch.
- Codex's rewrite of `docs/specs/STAGE_2_PART_4_POD_DISPUTES.md` is not included: see the decisions below.
- Defect fixed (22 November): the sweep of unrecorded files (from the 18b follow-up) counted only POD files, so it would have removed dispute evidence after its grace period. Migration 0034 now redefines `pod_storage_keys_in_use` to count evidence keys too, and the dispute test runs a sweep and reads the evidence back. With the evidence keys left out, that test fails.

## Decisions for Abdullah

1. **Model.** The approved spec (Stage 2 Part 4) says staff decide a dispute (upheld, partly upheld or rejected) with one appeal to a different staff member. This implementation is a mediation model instead: both contracting organisations must accept the same proposal, and staff do not decide. Codex rewrote the spec to match the code; that rewrite is not included here. Confirm the mediation model, or keep the spec and change the code.
2. **Approvals recorded in this file.** The file states that Abdullah approved the manual release rule on 19 November 2026 and explicit counterclaim terms on 20 November 2026. Confirm both, or correct them.
3. **Development defaults.** Dispute types, which party administrators act, staff privileges, and the 10 MiB evidence limit are development defaults.

## Codex's own verification (19-20 November, before the split)

Approval verification on 19 November 2026 passed two 18c API integration checks and one focused Chrome journey on isolated PostgreSQL. The API coverage includes release after withdrawal without a counterclaim and retention of the hold after recording an external decision. API, web and console builds passed. After explicitly labelling dispute inputs and sizing touch targets, the full web suite passed all 2617 checks on an isolated database. The focused Chrome journey also checks labels and target size.

- Isolated PostgreSQL: 22 checks passed across disputes, POD, POD storage, and 18d cargo. Dispute checks covered two-party approval of the current version, idempotency, loss of membership during a lock wait, private evidence and staff audit, linkage, counterclaims, and independent hold release.
- Web and console builds passed. The console browser regression suite passed 362 checks. A focused Chrome journey passed for the shipper, carrier and operations on an isolated database. It exercised a connection reset after commit, an uncertain outcome, retry without duplication, evidence upload, private notes, keyboard acceptance at 390 px in Arabic RTL with 200% text, independent release and an outsider refusal. A broader web run against the earlier draft of migration 0035 timed out opening a dispute. The corrected migration passed the isolated focused journey. CI was not run.
- An initial web browser run applied migration 0034 to the local development database during setup. The file retains the recorded checksum. The web harness now creates and drops an isolated database for every run. Subsequent verification and migration 0035 used isolated databases.
