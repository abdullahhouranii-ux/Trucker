# Trucker mobile (development)

Native React Native/Expo app for Android and iOS, not a WebView or a published store app.
It is independent of TruckLink, Odoo and the existing Family Kitchen emulator.

## Run

From the Trucker repository:

```powershell
npm ci --prefix apps/mobile --workspaces=false
Copy-Item apps/mobile/.env.example apps/mobile/.env
npm run mobile:check
npm run mobile:start
```

Set `EXPO_PUBLIC_API_URL` to a reachable API **origin**. `10.0.2.2` reaches the host from an
Android emulator; it is not a real phone address. Release builds require HTTPS, and credentials
or paths in this value are refused. Never put secrets in an `EXPO_PUBLIC_` variable.

Use `npm run android --prefix apps/mobile --workspaces=false` to choose a device explicitly.
Do not select the unrelated `fk_pixel` emulator. iOS native builds require macOS/Xcode.
The provisional development application identifier is `com.trucker.development` on both
platforms; production identifiers and signing accounts are not selected.

## Temporary local demo sign-in

On the Trucker Android emulator, reverse development ports 3000 and 8081 with ADB.
Run `npm run start:local-demo --prefix apps/mobile --workspaces=false` with the local
API in `development-display` mode, then select **Enter local demo**. The app verifies
an ephemeral code for a fictional test account over loopback. The code is never shown
on the phone. **Enter driver demo** uses the same fictional account and opens My trips.
The local scenario seed provides assigned bookings. Normal Metro startup hides both demo actions. Sign out of the fictional
account before switching back to a normal account.

## Delivered native screens

- EN/AR/UR language selection, phone/code sign-in and demonstration registration.
- Account overview, own sessions, revocation and sign-out confirmed by the server.
- Own driver assignments, acknowledgment, milestones, problem reporting, delivery outcomes.
- POD document selection, SHA-256 computed on the device, manifest-first upload, retry of
  missing items and safe recovery of a lost declaration response. Cached picker files are
  removed after successful upload or when the evidence screen unmounts (best-effort).
- Organisation chooser, paginated shipments across all statuses, shipment details, and read-only bookings.
- Paginated public home board for open published shipments, with pull-to-refresh.
- Sign-in recovery with the server's code retry wait and a fresh challenge when needed.

The rest of the company workflows remain in the web portal. This native version does **not**
yet include creating shipments, quoting, payments, fleet management, booking assignment,
POD review, staff-console access, push notifications or durable offline/resumable upload.
It never claims that an offline action reached the server. There is no live location tracking.

## Security and environment

Participant bearer tokens are stored with Expo SecureStore and never put in URLs or logs.
There is no staff login in this app. Server permissions and version checks remain authoritative.
A failed sign-out keeps the token; only a confirmed revocation/401 clears it.

No request asks the API to reveal a development sign-in code. Consequently a remote phone
cannot obtain codes from the local-only development adapter. Use a locally obtained test
code for controlled development, or integrate the approved message supplier before real use.
Nothing here opens production registration, file storage or payments.

## Verification, 19 November 2026

TypeScript and six API-client tests pass. Metro exports Android and iOS Hermes bundles
(approximately 1.6 MB each, uncompressed), including document picker and file-system modules.
This checks JavaScript/native-module resolution, not installable signed applications.

An Android Gradle build was attempted with Android Studio's JDK and the installed SDK.
Gradle stopped because Java reports the project/plugin directories as not writable in this
session. No APK was produced; no Windows permissions were changed. No physical-device,
TalkBack, VoiceOver, native picker or real-provider journey has been verified.

The mobile dependency tree/lockfile are isolated from Next.js because the supported React
versions differ. No root `npm ci` or root `verify` implicitly installs/tests mobile: use
`npm run mobile:check` after its own `npm ci`.

Based on the official Expo SDK 58 blank TypeScript template; its original 0BSD license is
included in `LICENSE`. App icon is a provisional locally drawn T, not an approved brand mark.

## Booking status slice — 20 November 2026

From Accounts → Bookings, an administrator can view operational closure status and, where the
server permits it, the platform fee invoice draft and recorded fee. The app reads the same
organisation-scoped closure and invoice-draft endpoints as the web. It suppresses unavailable
or hidden draft details and passes an expired session through the existing session handling.
The view is available in English, Arabic and Urdu.

TypeScript and seven mobile client tests passed. Metro exported the Android Hermes bundle
from the revised app. A signed debug APK was built for ARM64 and x86_64. Debug use requires Metro and a reachable Trucker API. No physical device was used.
