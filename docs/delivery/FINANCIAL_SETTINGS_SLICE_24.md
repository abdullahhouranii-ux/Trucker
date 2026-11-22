# Trucker: financial settings, slice 24 record

Date: 17 November 2026. Branch `feat/financial-settings`, stacked on PR #27. First slice of phase three (ADR-001 section 7). Built under Abdullah's instructions of 17 November 2026, "proceed all slices" (11:46) and "continue" (14:20). No scope document was approved for this slice; this record states what was built so it can be accepted or corrected. Model: `docs/specs/ADR_001_COMMERCIAL_MODEL.md` (version 0.3), requirements R-16, R-17 and R-18 and design G-7, not reopened. Nothing here is merged, deployed or approved for production, and no financial policy is approved by it.

## What changed

| Area | Change |
|---|---|
| Versions | Financial settings are versions. A staff administrator drafts one, with the reason and when it takes effect (on approval, or at a set time). A different administrator approves it. From its effective time it is the version in force |
| Never rewritten | An approved version is never changed, even by the migration role. A draft is discarded and a new one made. An approved version not yet in effect can be withdrawn; once in effect it can only be replaced by a newer one |
| What a version holds now | Trucker's fee (method, basis points, rounding); the commission options organisers may choose and the commission limit; the longest settlement period a commission contract may set; the freight due days |
| Bookings | A booking takes Trucker's fee and the freight due days from the version in force at the moment of acceptance, and records that version. Earlier bookings keep their figures and their version whatever later versions say |
| At the moment of change | A booking and an approval or withdrawal never interleave: each waits for the other. A booking accepted at the exact effective time uses the new version; one accepted a moment before uses the old |
| Commissions | The commission options and limits on the organiser's form, on contract proposals and in the checks come from the version in force. A commission already fixed on a published shipment keeps its value |
| Production | A production start is refused until an approved version, not the development default, is in force |
| History | Every version stays listed with who drafted, approved, discarded or withdrew it, and when. Each move and each refusal is in the staff audit |
| Console | A "Financial settings" page for administrators: the version in force, a form to draft a new version starting from it, every version with approve, discard or withdraw |
| Web | The commission and contract forms show the limit in force instead of a fixed figure, and offer only the options in force |

## Development defaults used (not approved for production)

| Item | Value used |
|---|---|
| Starting values | The development default version carries the values in use before this slice: fee 300 basis points (D-4), freight due 15 days (D-9), commission limit 25% (D-3), all three commission options, longest settlement period 60 days |
| F-1 | Drafting and approving need the existing staff administrator privilege. No separate finance privilege was created |
| F-2 | Withdrawing a version that has not taken effect needs one administrator, any of them. It keeps the version already in force, so I did not require a second person |
| F-3 | A version may take effect at approval, or at a set time later than the draft |
| Bounds of each setting | Fee 0 to 5,000 basis points; commission limit 1 to 5,000 basis points; settlement period 1 to 365 days; freight due 0 to 365 days. These are input bounds, not policy |

## How it is built

Migration `0022_financial_settings.sql`, forward-only. Table `financial_setting_version`, closed to the API's database role. A trigger allows only three moves (draft to approved, draft to discarded, approved but not yet in effect to withdrawn), never a change of value, never a removal. The approver must differ from the drafter, by a table constraint as well as in the command. The version in force at a moment is the approved version with the latest effective time at or before it. `acceptance_terms` reads the fee and freight due days from that version under a shared lock; approval and withdrawal take the same lock exclusively, then read the clock. A trigger on each new booking records the version and refuses a booking whose figures differ from it. `booking_fee_basis_points` and `booking_payment_due_days` are removed from `security_setting`, so there is one source for each value. New commands: `staff_financial_settings`, `staff_financial_draft`, `staff_financial_move`, `financial_settings_ready`. API routes: `GET` and `POST /staff/financial-settings` (the draft needs an `Idempotency-Key`), `POST /staff/financial-settings/:id/moves`.

## Evidence (Linux, PostgreSQL 16, recreated database)

| Check | Result |
|---|---|
| `npm run verify` | Passed: API 347 pass, 0 fail (4 new tests in `staff/finance.test.ts`; earlier tests that changed the fee through the security settings now do it through versions); web 24; console 9 |
| Builds | Passed |
| Web browser checks | All passed, including a new check that the commission hint shows the limit in force |
| Console browser checks | All passed, including the new two-administrator journey: a draft refused for an out-of-range figure, the drafter's own approval refused, a second administrator's approval in force at once. The first run failed six accessibility checks on the new page (date and time inputs that cost extra Tab stops; sideways scroll at doubled text). Fixed using the console's existing form patterns; the rerun passed |
| Stability | The new tests ran 3 times in a row without failure |
| Deliberate faults | Thirteen faults put into the migration one at a time. Twelve were caught at once. One was missed: a value changed together with a permitted move. A test for it was added and now catches it |

Also found and fixed during the slice: a standing safeguard test refused the new approval command because its version parameter was not named as every other one is; renamed, not weakened.

## Not done, and limits

- The fee payer, the fee payment deadline and refund rules are not yet in the versions. They join with fee payment (phase four) and the price breakdown (next slice).
- The booking settings that are not financial (assignment hours, reservation margins) stay in the security settings.
- Bookings made before this migration record no version: they were made under the security settings.
- Neither participants nor the staff console show a booking's version yet. The price breakdown of the next slice will show it.
- Reading the settings needs the administrator privilege; reviewers cannot see them.
- Wording and layout points are in the final-audit backlog.

## Decisions needed (none blocks the next slice)

- **F-1.** Should drafting and approving financial settings need a separate finance privilege rather than staff administrator? I recommend a separate privilege before production, so that the people who manage staff accounts are not by that alone the people who set prices.
- **F-2.** Should withdrawing a scheduled version need a second administrator? I recommend not: a withdrawal only keeps the version in force.
- The production values of every setting remain yours to approve (D-3, D-4, D-9 and the rest of ADR-001 section 5).
