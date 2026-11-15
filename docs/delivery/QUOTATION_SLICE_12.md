# Trucker: quotation slice 12, record

Date: 15 November 2026. Branch `feat/quotations`, based on `feat/carrier-discovery` (PR #15, unmerged). Scope: QUOTATION_SLICE_12_SCOPE.md (approved, with safeguards SG-1 to SG-6).

Nothing is accepted, awarded, booked, reserved, invoiced or paid. No fee, tax treatment, payment or resource field exists. All data is fictional.

## What was built

| Part | What it does |
|---|---|
| Migration `0010_quotations.sql` | Currency and inclusion registers, empty after migrations. Per-shipment terms (currency and a snapshot of the inclusions). Quotations, immutable versions, retry keys and a read log. All are reached only through functions; the API role has no table rights |
| Terms (SG-1, SG-4) | The shipper's administrator chooses one currency offered for the pick-up country. The terms carry every inclusion of the register. They are locked once any quotation exists, whatever happened to it since |
| Amounts (SG-2) | Exact `numeric`, carried as a string from the form to the database and back. Scale at most the currency's minor units, above zero, below 10^12. A JSON number is refused. The shipper's list compares amounts with BigInt, never floating point |
| Comparability (SG-4) | A quotation must answer included or not included for every inclusion of the terms, and nothing else. Missing inclusions are reported by field |
| Validity | At least the minimum validity (protected setting) and never after the shipment's quotation deadline (QB-8a). The earliest pick-up must be inside the pick-up window. Times are local to the pick-up place, with clock-change checks |
| Expiry (SG-5) | At `least(valid_until, deadline)` by the database clock, recorded once with the system as actor, without a worker. Suspension does not pause it |
| Standing | Judged live at every read: `current`, `needs_reconfirmation`, `carrier_not_eligible`, `shipment_suspended`, `expired`, `shipment_closed`, or the quotation's own ended status. Resumption therefore rechecks eligibility, validity and reconfirmation (SG-5) |
| Shipment changes | A trigger on the shipment closes open quotations when the shipment is withdrawn, and marks them for reconfirmation once per shipment version on a material change. A shortened deadline that the validity exceeds needs a revision |
| Carrier commands | Submit, revise (new version, limit per quotation), reconfirm, withdraw. One open quotation per carrier per shipment, enforced by a unique index. Lock order: carrier organisation, shipment, quotation; then the clock |
| Shipper | Lists the quotations on its shipment, open ones first and lowest amount first, with the carrier's name and verification status (QB-5), and rejects an open one. Each read is logged |
| Staff | `GET /staff/shipments/:id/quotations`, read-only, audited as `staff.quotation_view`. The console shipment page shows a read-only quotations section |
| Web | Quotation form on the discovered shipment, the carrier's own list, the shipper's quotations page, links from the shipment and discovery pages. EN, AR and UR (AR and UR drafts, TR-16) |
| Development defaults (SG-6) | Minimum validity 15 minutes, 100 open quotations per carrier, 5 versions per quotation. Protected settings needing production review |

## Defects found and fixed during the build

| Defect | Fix |
|---|---|
| An empty amount was not reported when other fields were also missing: the form reported only the others | The web action reports a missing amount with the other field problems |
| An inclusion name at doubled text overflowed a 390-pixel screen (nested fieldsets) | Legends wrap; nested fieldsets have less padding |
| The discovered-shipment page, the discovery list and both new quotation pages sent the user to sign-in with "session ended" when the API gave no answer. The session was unconfirmed, not ended. Two of these pages came from slice 11 (PR #15) | The pages no longer treat an unconfirmed session as ended; the requests fail as unavailable and are shown as such, and a 401 still ends the session. A browser check opens the quotation page with the API unreachable; it failed with the old line restored and passes now |

## Evidence

| Check | Result |
|---|---|
| `npm run verify` (format, lint, types, API tests, web and console unit tests) | Passed: API 278 pass, 0 fail (SEC-01 `todo`); web 24; console 9 |
| Quotation API tests | 13 tests, all pass |
| Deliberate defects in 0010, each caught by the intended test | scale check removed (test 3), inclusion check removed (3), suspension pausing expiry (9), eligibility not rechecked (9), reconfirmation not marked (8), terms not locked (2), withdrawal not closing quotations (10). Migration restored, byte-identical |
| Web browser checks | All passed, including 8 quotation checks and 30 lost-answer checks: terms, problems by field, three decimal places, lost submission recorded once, API unreachable, comparison without registration numbers, lost withdrawal recorded once, a new quotation and its rejection, three languages at four widths and with text doubled |
| Console browser checks | All passed, including the read-only quotations section |

## Not covered or still open

- CI has not run on this branch yet at the time of writing; see the PR.
- No real currency, inclusion register, fee, tax treatment or payment rule. These are Release 1 decisions (RELEASE_1_READINESS.md).
- The shipper sees the carrier's name before acceptance (QB-5). Contact between the parties outside Trucker is not controlled.
- Quotation read-log retention is unresolved, as for the carrier access log.
- SEC-01 remains open and deferred, blocking production and real staff use.
