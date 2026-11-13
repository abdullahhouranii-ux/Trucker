# Design in the repository

Working direction: "A" (Signage) with numbered steps, approved by Abdullah on 13 November 2026 as a
direction for expansion only. No screen and no accessibility claim is approved.

| What | Where |
|---|---|
| Tokens (source) | `apps/web/src/design/tokens.json`, version 0.3.0, provisional |
| Tokens (generated) | `apps/web/src/design/tokens.css`. Regenerate with `npm run tokens -w @trucker/web` |
| Styles and components | `apps/web/src/styles/site.css`, `apps/web/src/components/` |
| Evidence for each slice | `docs/delivery/` (web shell: `WEB_FOUNDATION_SLICE_3.md`) |
| Screen inventory and coverage matrix | Claude project document "Trucker - Screen inventory and coverage matrix (provisional)", 131 screens |

## Token versions

| Version | Change |
|---|---|
| 0.2.0 | Prototype only (not in this repository) |
| 0.3.0 | First version in the repository. Same values as 0.2.0. Adds declared contrast pairs that a test enforces. Nastaliq removed from the loaded fonts |

## Screens built in the repository

| Inventory ID | Screen | Languages | States built | Evidence |
|---|---|---|---|---|
| A-01 | Public home page | EN, AR, UR (drafts) | Default only | WEB_FOUNDATION_SLICE_3.md |
| A-15 | Not found | EN, AR, UR (drafts) | Default only | WEB_FOUNDATION_SLICE_3.md |
| X-01, X-02 | Sign in or register: mobile number, then one-time code | EN, AR, UR (drafts) | Default, validation, failure (wrong, expired, replaced, locked, used code; too soon; too many), session ended | REGISTRATION_SLICE_4.md |
| X-04 | Terms shown at registration (demonstration text only) | EN, AR, UR (drafts) | Default, validation, closed | REGISTRATION_SLICE_4.md |
| X-01 (second part) | Finish registration: name, optional e-mail | EN, AR, UR (drafts) | Default, validation, success | REGISTRATION_SLICE_4.md |
| X-05 | Session ended | EN, AR, UR (drafts) | Shown as a message on the sign-in page | REGISTRATION_SLICE_4.md |
| X-07 (part) | Account: own details, sessions, end a session, sign out | EN, AR, UR (drafts) | Default, success, failure (revocation not confirmed, with retry), service not answering, browser-only sign-out. No editing, no language preference, no device names | REGISTRATION_SLICE_4.md |
| B-01 | Organisation onboarding: create a draft shipper organisation, see it, change it | EN, AR, UR (drafts) | Default, validation, success, failure (not confirmed, changed elsewhere, limit, closed), service not answering | ORGANISATION_ONBOARDING_SLICE_5.md |
| X-09 (part) | Choosing an organisation: the list of the person's organisations; the one in use is named on its page | EN, AR, UR (drafts) | Default, empty, service not answering. No role switch, no switcher in the header | ORGANISATION_ONBOARDING_SLICE_5.md |

Components added in slice 5, with no token change: drop-down list, multi-line text box, draft chip,
organisation card. Tokens stay at 0.3.0.

Components added in slice 4, with no token change: form field, error summary, notice (error, success,
development), checkbox, primary button, fact list. Tokens stay at 0.3.0.

Everything else in the inventory is not built. The prototype's operations and driver screens are
not in the repository.
