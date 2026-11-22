# Pilot invitations (DB-17)

Date: 22 November 2026. Branch `feat/pilot-invitation`, pull request against `staging`. Built under Abdullah's instruction of 22 November 2026 (13:35, "Build the pilot invitation"), on the recommended answer to DB-17 in `RELEASE_1_GAP_TO_LAUNCH.md`. Not merged. Migration `0042_pilot_invitations.sql`.

## What works

- A staff administrator records an invitation for a named contact of an organisation: the mobile number, the organisation's name and the person's name. This is the **Pilot invitations** page of the console (`/pilot`), under "Verification and staff".
- **Nothing is sent.** There is no message supplier yet, so staff tell the contact themselves that they can register. No contact detail is invented or looked up.
- While invitations are required, registration needs a pending, unexpired invitation for the person's own number. A driver invited by a carrier also registers without one: the carrier is itself in the pilot. Anyone else is refused with "Registration is by invitation during the pilot", in English, Arabic and Urdu. The refusal is recorded as an identity event and the person stays unregistered.
- Registration takes the invitation once, in the same transaction, and records who took it. A taken number cannot be invited again: it is registered.
- An invitation expires after a set number of days. Staff can cancel an open one. A number has at most one open invitation; a new one for the same number is refused until the open one is cancelled or has expired. An expired one is kept as expired when a new one replaces it.
- Every invitation and cancellation, and every refused attempt by staff without the privilege, is in the staff audit list. The audit entries name the invitation, not the number or the names.
- An invitation is never deleted or rewritten. The API's database role cannot read the table; only the staff functions and registration reach it.

## Development defaults (not approved for production)

| Setting | Default | Meaning |
|---|---|---|
| `pilot_invitation_required` | `0` (off) | `1` makes registration need an invitation. Off by default so local work and the existing tests are unchanged. **Must be `1` before production.** |
| `pilot_invitation_days` | `14` | How long an invitation stays open (1 to 90) |

Both are protected settings, changed with `npm run dev:settings -- pilot_invitation_required=1`.

Only staff administrators invite and cancel. Pilot size and duration (D-012, readiness R1-P3) are still yours to set.

## Not built

- Sending the invitation by SMS or WhatsApp: needs a supplier.
- Limiting which organisation the invited person may create: the organisation name on the invitation is a record for staff, not a rule.
- Native Arabic and Urdu review of the new message (see `FINAL_AUDIT_BACKLOG.md`).

## Verification (22 November 2026, Node 24, isolated PostgreSQL)

| Check | Result |
|---|---|
| `staff/invitation.test.ts` | 7 of 7 pass: registration needs an invitation and takes it once (PIL-1); expiry, cancellation, a stale version, a new invitation after expiry (PIL-2); a driver invited by a carrier (PIL-3); nothing changes when not required (PIL-4); only administrators, checks by field, no number in the audit (PIL-5); never removed or rewritten, closed to the API role (PIL-6); a registration and a cancel at the same moment (PIL-7) |
| Deliberate faults in `0042` | Four, one at a time, all caught: the requirement ignored (PIL-1, PIL-2); no exemption for invited drivers (PIL-3); expiry ignored (PIL-2); the invitation not marked taken (PIL-1, PIL-4, PIL-7) |
| Hardening, organisation and identity tests | Pass, with the three new functions and the new table on their lists |
| Console browser suite | All checks pass, including the new page: a refusal by field, an invitation recorded and listed, a cancellation, each state checked for keyboard, layout and accessibility rules |
