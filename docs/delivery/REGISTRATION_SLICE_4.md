# Slice 4: registration and sign-in

Date: 13 November 2026. Branch `feat/registration`, pull request against `staging`. Not merged.

**Depends on pull request #5** (web foundation). This branch is built on top of
`feat/web-foundation`; until #5 is merged, this pull request also shows #5's commit. Merge #5
first. It does not depend on pull request #4 and touches none of #4's files.

## 1. The journey that now works

A visitor enters an international mobile number, receives a one-time code, enters it, and is
signed in. A new number continues to registration: name, optional contact e-mail, and a
demonstration terms notice. The account page shows the person and their sessions, and lets them
end any session or sign out. Everything is stored in PostgreSQL; nothing is simulated except the
delivery of the code, which no supplier exists for yet.

Shown in English, Arabic and Urdu, with right-to-left layout for Arabic and Urdu.

## 2. Decisions applied (Abdullah, 13 November 2026)

| Decision | How it is built |
|---|---|
| Sign in with an international mobile number and a one-time code | `person.phone_e164` is the only identifier. Numbers must include the country code; none is assumed |
| E-mail is optional contact detail; recovery by e-mail is a separate, later decision | `contact_email` is unverified, is never used to sign in, and no recovery route exists. A person who loses the number cannot sign in. This is a known gap, not a choice of policy |
| Code and session periods are development defaults needing production review | Section 4. Production refuses to start unless every period is set explicitly |
| Demonstration terms only, never represented as approved legal terms | Section 5. Production refuses the demonstration setting, so production registration is closed |
| Codes shown only in an explicitly enabled, locally isolated development environment | Section 3 |
| Fictional data only as isolated test fixtures | Tests use country code +999, which is not assigned. No country, lane or document is seeded |

Decisions 4 and 5 of that message (drafts on closed routes; fictional countries and lanes) apply
to the shipment slice and are not used here.

## 3. Where a one-time code can appear

| Place | Code present? |
|---|---|
| Database | No. Only a keyed hash (HMAC-SHA-256 with the server secret, bound to the challenge) |
| Logs | No. The request log holds method, path, status and duration only. A test reads the log and fails if the code, the token or the number appears |
| API response | Only when `SIGN_IN_CODE_DELIVERY=development-display` **and** the caller is on the same machine, and only in the first answer |
| Address bar | Never. The web application keeps sign-in progress in an HttpOnly cookie |
| Production | Never. `development-display` is refused at start in production, and anywhere the database is not on the same machine |

With the default setting (`none`) no code is created at all and sign-in answers 503. That is the
state of any environment without a message supplier, including production today.

## 4. Security periods: development defaults that need production review

| Setting | Default | Why this value | To review before production |
|---|---|---|---|
| `SIGN_IN_CODE_TTL_SECONDS` | 300 | Long enough for a delayed text message; short enough that an overseen code soon stops working | Real delivery times of the chosen supplier per country |
| `SIGN_IN_CODE_MAX_ATTEMPTS` | 5 | Allows typing mistakes. Five guesses at a six-digit code succeed with probability 5 in 1,000,000 | Whether support load from lock-outs is acceptable |
| `SIGN_IN_CODE_RESEND_WAIT_SECONDS` | 60 | Stops repeated sending by mistake or abuse, each of which will cost money once a supplier exists | Supplier cost and delivery delay |
| `SIGN_IN_CODE_MAX_PER_HOUR` | 5 | With the attempt limit, bounds guessing to 25 in 1,000,000 per number per hour, and bounds message cost | Abuse patterns; a per-device or per-address limit is not built |
| `SESSION_IDLE_MINUTES` | 30 | A shared office computer left unattended is signed out | Too short for a dispatcher's working day? The driver app will need its own, longer rule |
| `SESSION_ABSOLUTE_HOURS` | 12 | One working day, then sign in again | As above |

These are engineering starting points, not legal or regulatory advice. Each has tests at its
boundary (section 7). In production the API refuses to start if any of them is left unset.

## 5. Terms

- The API serves a short **demonstration** notice in three languages, version
  `demonstration-2026-11-13`. It says it is placeholder text, not a legal agreement.
- Completing registration records the kind (`demonstration`), version, language and time.
- The database accepts no other kind. Adding approved terms needs a new migration, on purpose.
- `REGISTRATION_TERMS=demonstration` is refused in production; with `none`, completing
  registration answers 503 `registration_closed`.

## 6. What was built

**Database** (`db/migrations/0002_identity.sql`): `person`, `session`, `sign_in_challenge`,
`terms_acceptance`, `identity_event`.

**API** (`apps/api/src/identity/`):

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /auth/code-requests` | Anyone | Create a code. Same answer for known and unknown numbers. Needs `Idempotency-Key` |
| `POST /auth/code-verifications` | Anyone | Exchange a correct code for a session. Needs `Idempotency-Key` |
| `GET /registration/terms` | Anyone | The demonstration notice in a language |
| `GET /me` | Signed in | Own person and session |
| `POST /me/registration` | Signed in | Complete registration |
| `GET /me/sessions` | Signed in | Own open sessions |
| `DELETE /me/sessions/:id` | Signed in | End one own session. Another person's session answers 404, like one that does not exist |
| `POST /me/sessions/revoke-others` | Signed in | End every other own session |
| `POST /auth/sign-out` | Signed in | End the current session |

**Safe retries**

- Repeating a code request with the same key returns the same challenge; no second code.
- Repeating a verification with the same key and code within two minutes returns the same
  session; any other reuse of a code answers 409. The token is derived from the session
  identifier with the server secret, so it can be returned again without being stored.
- Completing registration twice changes nothing.
- Wrong attempts are counted under a row lock; twelve simultaneous wrong attempts leave the
  count at exactly the limit, and two simultaneous correct attempts create one session.

**Web** (`apps/web`): `/sign-in`, `/sign-in/code`, `/register`, `/account` in each language.
Forms post to server actions; the browser never calls the API and never holds the token (HttpOnly,
SameSite=Lax cookie; Secure when the build is marked production).

**Lessons from the prototype, applied here**

- A started form survives a language change: registration and sign-in fields are kept in the
  browser tab and restored (checked in all three languages). The one-time code is never kept.
- Nothing is simulated silently: the only stand-in is the code display, shown in a dashed
  "Development only" box that says no text message is sent.
- The two queue rules (separate reports; no dependent milestone overtaking a failed event) have
  nothing to apply to yet. They remain requirements for the driver slices.

## 7. Checks and results

Run on 13 November 2026, Linux, Node.js 22, PostgreSQL 16, headless Chrome.

| Check | Count | Result |
|---|---|---|
| API tests, all (`npm test -w @trucker/api`) | 87, of which 43 are new | Pass |
| Web unit tests | 17, of which 2 are new | Pass |
| Browser checks (`npm run test:browser`), all | 356, of which 253 are new | Pass |

One unexplained result is on record: in a single local run of the whole suite, one API test
failed (86 of 87). The output of that run was not kept, so the test is not identified. 17 further
runs, 8 of them under heavy processor load, all passed. Treat the suite as possibly having one
timing-sensitive test until it is seen again and fixed.

New API tests include the negative cases asked for:

| Case | Expected |
|---|---|
| Code used twice | 409 `code_already_used`, no token |
| Code expired (exact boundary, clock moved in the test) | 410 `code_expired`; a code one second younger still works |
| Too many wrong attempts | Remaining attempts counted down, then 429 `code_locked`; the right code is then refused too |
| Simultaneous wrong attempts | Count never exceeds the limit |
| Older code after a newer one | 410 `code_replaced` |
| Asking again too soon; too many per hour | 429 with the seconds to wait |
| Session after sign-out, after being ended from another session, after "end all others" | 401 |
| Idle session; session at its absolute limit | 401 `session_expired`, reason recorded |
| Another person's session | 404; it keeps working |
| Missing, malformed or forged token on every personal endpoint | 401 |
| Production configuration with code display, demonstration terms, missing secret, published secret, or any period unset | Refused at start |
| Terms kind other than demonstration, inserted directly | Refused by the database |

New browser checks run the whole journey in each language against the real API and database:
empty and invalid input (focus moves to the error summary, which links to the field; typed values
are kept), wrong code (attempts left shown), correct code, registration with a draft kept across a
language change, account, reload (still signed in), a second browser signing in as the same person
and being ended from the first, sign-out, and asking for a code again too soon. Each of 7 screen
states x 3 languages is checked at 320, 390, 768 and 1280 px, with the text size doubled, for
labels, heading count, direction, target size, and with axe-core (WCAG 2.0 to 2.2 A and AA rules:
0 violations).

## 8. Design defects found on the real screens and fixed

- Focus did not move to the error summary after a refused form; fixed and checked.
- Error-summary links were under 24 px high; enlarged.
- The header took five rows on a phone on task pages; it now shows only the account link there.
- Error-summary bullets sat under wrapped text; the list is now plain.
- The code field sat on the wrong side in Arabic and Urdu; aligned to the start.

## 9. Limits and what is not claimed

- **No message supplier**: outside local development nobody can sign in. Choosing one is a paid
  service and needs Abdullah's approval.
- **No account recovery.** Losing the number means losing access until recovery is designed.
- **No limit per device or network address**, and no check against automated sign-up.
- Phone numbers are checked for shape only (E.164), not for being a mobile line.
- A draft survives a language change only with scripts enabled; without scripts the page still
  works but the typed values are lost on a language change.
- Staff sign-in, organisations, memberships and roles are not part of this slice. The only
  permission rule here is "a person acts on their own sessions and registration".
- Not checked: physical phones, Safari, Firefox, screen readers, native-reader review of Arabic
  and Urdu. No accessibility conformance is claimed.

## 10. Documentation to align once pull request #4 is merged

This pull request does not edit files changed by #4. After #4 merges, these edits are due:

| File | Edit |
|---|---|
| `docs/specs/STAGE_2_PART_1_IDENTITY_OWNERSHIP_PERMISSIONS.md` | Q-101 answered: mobile number with one-time code; e-mail optional contact only; recovery open. REQ-ID-01 and REQ-ID-02 partly implemented, with the limits in section 9 |
| `docs/specs/STAGE_1_BASELINE.md` | Decision register: Q-101 closed on 13 November 2026; C-06 confirmed in part (staff second factor and recovery still open) |
| `docs/delivery/STATUS.md` | Add slices 3 and 4 |

## 11. Needs Abdullah

1. Review and merge order: #5, then this pull request. #4 is independent.
2. Production review of the six security periods (section 4).
3. Account recovery: a design decision is needed before real users exist.
4. A message supplier, when you are ready to consider paid services.
