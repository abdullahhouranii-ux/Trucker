# Foundation slice 3: web application shell

Date: 13 November 2026. Branch `feat/web-foundation`, pull request against `staging`. Not merged.
Status file note: `docs/delivery/STATUS.md` is also changed by open pull request #4, so this slice
records its status here to avoid a conflict. STATUS.md should gain one line for this slice when
either pull request is merged.

## What this slice is

The web half of milestone M0 ("runnable API/web/PostgreSQL foundation"). It adds `apps/web`, a
Next.js application that every later journey will be built in. It has no sign-in, no forms, no API
calls and no database access. No business rule is implemented or implied.

## What was built

| Part | Detail |
|---|---|
| Application | `apps/web`, Next.js 16.4.6, React 19.3.1, TypeScript. Pages are generated at build time |
| Languages | English, Arabic, Urdu under `/en`, `/ar`, `/ur`. `<html>` carries the language and direction. `/` goes to `/en` (temporary redirect) |
| Right to left | One stylesheet using logical properties. References, times and numbers are left-to-right islands (`Ltr` component) |
| Messages | One catalogue per language. A test fails if a key is missing, extra or empty in any language; a missing key is also a compile error |
| Design tokens | `src/design/tokens.json` version 0.3.0 (provisional) generates `tokens.css`. A test fails if they disagree, and another if any declared colour pair is below its required contrast |
| Fonts | Barlow and Noto Sans Arabic are served from the application itself. The pages contact no other host (checked) |
| Environment sign | One striped banner says this is a development build with sample content. It is shown unless the build is marked production; no production environment exists |
| Pages | Home page (illustrative trip, how it works, who it is for, languages); a not-found page in the reader's language; unknown languages answer 404 |
| Components | Environment banner, site header, language switch, sign plate, button, status chip, numbered steps, left-to-right island |

Urdu body text uses Noto Sans Arabic provisionally. Nastaliq is not loaded; it stays optional for
large display text, subject to testing with Urdu readers on phones.

## Corrections made to the prototype design while building

- The prototype's phone "Menu" button is gone: the three navigation links wrap instead, so nothing is hidden behind a control.
- "Register" and "Sign in" are not shown, because they do not exist yet. No control leads nowhere.
- The hero heading no longer breaks to one word per line when the reader doubles the text size.
- A navigation link 40 px wide in Urdu was widened to the 44 px minimum.
- The not-found page is shown in the reader's language instead of English.
- Language is chosen with links to the same page, so it works without scripts and keeps the address.

## Checks and results

Run on 13 November 2026 on Linux, Node.js 22, headless Chrome, against the production build
served by `next start`. Commands: `npm run verify` (unit level) and `npm run test:browser`.

| Check | Count | Result |
|---|---|---|
| Unit tests: language rules, catalogue parity, tokens in step, contrast of 22 colour pairs | 15 tests | Pass |
| Routing: `/` redirect, unknown language 404, unknown page 404 in the reader's language, no framework header | 6 | Pass |
| Language and structure: language and direction on `<html>`, one main heading, one main region, heading levels in order, current language marked, language link keeps the page | 16 | Pass |
| Fonts loaded and Arabic-script body font applied | 6 | Pass |
| No request to any other host | 1 | Pass |
| Responsive: 3 languages x 10 widths from 320 to 1920 px, no sideways scrolling, nothing outside the viewport or clipped | 30 | Pass |
| Zoom: 1280 and 390 px at 200% zoom; 390 and 320 px with text size doubled, 3 languages | 12 | Pass |
| Keyboard: every control reached by Tab, in reading order, each with a visible focus indicator; skip link moves focus to the content | 10 | Pass |
| Touch targets at least 44 px, 3 languages x 2 widths | 6 | Pass after one fix |
| Left-to-right islands stay left to right and on one line | 6 | Pass |
| Reduced motion: nothing animates | 1 | Pass (nothing animates in this slice at all) |
| Automated accessibility rules (axe-core, WCAG 2.0 to 2.2, A and AA), 4 pages x 2 widths | 8 | 0 violations |

## Not checked, not claimed

- No physical phone, no Safari or Firefox, no screen reader.
- Arabic and Urdu wording is a draft and has not been reviewed by native readers.
- Automated accessibility rules cover only part of WCAG. This slice does not claim conformance.
- The Windows CI job builds the application but does not run the browser checks.
- Language negotiation from the browser's preference is not built; `/` always goes to English.

## Lessons carried from the prototype into the next slices

These defects were found in prototype 0.2 and must not be copied. None applies to this slice,
which has no forms or queue; they are recorded here as requirements for the slices that do.

1. A second report must not replace the first. Each report is its own record.
2. A milestone that depends on an earlier unsent or failed event must not be sent before it.
3. A form the user has started must survive a language change.
4. The screen must say whether something is saved durably or only simulated. From the first
   functional slice there is no simulation: saved means stored in PostgreSQL.

## Decisions that block the next functional slice

Next slice: registration, then organisation onboarding, then shipment draft and list.

| Decision | Blocks | Why it cannot be defaulted |
|---|---|---|
| S-1 (Q-101) Sign-in method | Registration | Decides the identifier, the tables and what a person must own to use the product |
| S-8 Security periods: code life, attempt limits, session length, retry-key life | Registration | They are security policy. Values will be proposed in the pull request, but need approval |
| S-5 Save a draft on a route that is not open, or refuse it | Shipment draft | It is product behaviour visible to shippers |
| Terms and privacy text accepted at registration (REQ-ID-02) | Registration | No approved text exists. A clearly labelled placeholder version can be recorded only if you agree |

Not blocking, if you accept provisional development data (never launch configuration): S-2
countries, S-3 lanes, S-4 document list, S-7 local file storage, S-9 development staff accounts.
D-001, D-002 and the launch countries do not block this journey.
