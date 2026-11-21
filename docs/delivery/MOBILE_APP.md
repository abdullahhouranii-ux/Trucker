# Native mobile app (Expo, Android and iOS)

Implemented by Codex locally (unreviewed branch `codex/unified-experience-mobile`, described in `UX_REDESIGN_MOBILE_2026_11_19.md`) and split into its own branch, `feat/mobile`, on 22 November 2026, stacked on `feat/redesign`. Development only: nothing is built for or published to the stores.

## What it is

- One app for participants and drivers, with roles by account: shipments (draft, edit, publish, withdraw), quotations (submit, withdraw, accept, reject), authorities and commission contracts for brokers, and the driver's trips (acknowledge, milestones, problems, delivery outcome, proof of delivery, arrival estimate, dispute photos).
- It talks only to the existing API; it adds no server rule. `apps/mobile` is outside the npm workspaces and has its own lockfile. Root scripts: `npm run mobile:check` (type check and tests) and `npm run mobile:start`.
- A local demo sign-in exists for development only: it is off unless the app runs in development mode with `EXPO_PUBLIC_TRUCKER_LOCAL_DEMO=1` against `http://127.0.0.1:3000`, and it uses the server's existing one-time code, which the server shows only on a database marked local-development.

## Verification (22 November 2026)

| Check | Result |
| --- | --- |
| `npm run mobile:check` | Type check passes; 32/32 tests pass |
| `expo export` for Android and iOS | Both bundles build |
| `npm run verify` (API, web, console) | API 431 pass, 2 skipped (browser journeys); web 24/24; console 9/9 |
| On a device or emulator | Not run here. Codex reports emulator runs of draft editing, currency choice, quoting and acceptance |

## Open, and decisions for Abdullah

1. **Licence file.** `apps/mobile/LICENSE` is the MIT notice of the Expo template (copyright 650 Industries), while `package.json` says 0BSD. Decide the app's licence notice.
2. **Store release.** App identifiers, signing keys, store accounts and publishing need your approval.
3. **Not built yet** (Codex's report): live GPS tracking, cash collection by the driver, and sharing photos.
