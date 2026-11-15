# Trucker: Release 1 readiness checklist

Version 0.1, 15 November 2026. Status: **planning document. No item is decided or done unless marked so with evidence.** Owner of every decision: Abdullah.

## Release 1 definition

An invitation-only shipment-and-quotation pilot. In scope:
- registration;
- organisation verification;
- shipment publication;
- carrier discovery;
- comparable quotations.

Out of scope: acceptance, booking, vehicle or driver commitment, invoicing and payment.

The launch country and lanes are **not chosen** here. The regional architecture stays (countries, currencies, time zones and rules are configuration), and the GCC stays the priority. Nothing below assumes a country.

Status values: **Open** (nothing done), **Partial** (some of it is built or checked, with evidence named), **Done** (with evidence). Legal and regulatory items list the questions only. Whether any requirement applies is for qualified advisers in the chosen country to say.

## 1. Product scope and invitation

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-P1 | Release 1 scope as above confirmed in writing | Partial | Stated by Abdullah on 15 November 2026; record it in docs/specs with D-numbers |
| R1-P2 | Invitation mechanism: how a pilot organisation is admitted (allow-list, invitation code, staff enabling) | Open | Not built. Registration is closed in production. Needs a decision, then a slice |
| R1-P3 | Pilot size: number of shippers, carriers and staff, and duration | Open | Decision |
| R1-P4 | Exit criteria: what the pilot must show before acceptance and booking are built | Open | Decision |
| R1-P5 | Screens and messages say plainly that nothing is accepted, booked or paid | Partial | Present on the quotation screens (slice 12); confirm in the final audit |

## 2. Launch geography (no automatic choice)

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-G1 | First country or countries enabled (D-003b) | Open | Decision. GCC priority |
| R1-G2 | First lanes (D-003c) | Open | Decision |
| R1-G3 | Real country configuration: time zones, registration identifiers, evidence requirements, route rules | Open | Only fictional countries XA and XB exist |
| R1-G4 | Real currency per enabled country, with minor units (QB-3 production) | Open | Only the test code XTS exists |
| R1-G5 | Languages for the pilot: EN, AR and UR all, or a subset | Open | Decision; all three are built |

## 3. Legal, commercial and tax decisions

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-L1 | Business entity and where it is established (Oman/UAE comparison exists, provisional) | Open | Decision with advisers |
| R1-L2 | Participant terms of use and privacy notice, approved by a lawyer for the chosen country | Open | Only demonstration terms exist; production registration is closed until approved |
| R1-L3 | Professional translation of approved terms into the pilot languages | Open | After R1-L2 |
| R1-L4 | Whether a licence, permit or registration is needed to operate a freight marketplace or to act as agent in the chosen country | Open | Question for advisers. Nothing is assumed |
| R1-L5 | Data protection: lawful basis, data residency, cross-border transfer, retention periods | Open | Question for advisers; feeds R1-S7 |
| R1-L6 | Agent model wording: what Trucker is and is not responsible for in a quotation (D-001c) | Open | Lawyer review |
| R1-C1 | Trucker's fee during the pilot: none, or how it is set and who pays (D-001a, D-001b) | Open | Decision. No fee field exists; a pilot without a fee still needs the statement recorded |
| R1-C2 | Tax treatment of quoted amounts: stated with or without tax, and what the screen says | Open | Accountant review. The quotation form says only that Trucker does not determine how tax applies |
| R1-C3 | Real inclusions register for quotations (QB-4 production) | Open | Decision. Fictional items only in development; register empty in production |
| R1-C4 | Production limits: minimum validity, open quotations per carrier, versions per quotation, discovery page size and read limit, cursor lifetime, session limits | Open | All are development defaults; review as one settings decision |
| R1-C5 | Pilot agreement with participants (free pilot, no service level, feedback consent) | Open | Decision and lawyer review |

## 4. Real verification

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-V1 | Real evidence requirements per country for shipper and carrier capabilities | Open | Fictional requirements only; verification is demonstration and cannot allow production publication or discovery |
| R1-V2 | Document upload, storage, encryption and access by staff | Open | Not built; document numbers only today |
| R1-V3 | How staff check evidence (registry lookup, manual check), and the reviewer guide | Open | Decision, then a slice |
| R1-V4 | Reviewer staffing and the conflict-of-interest rule | Partial | No-conflict declaration exists in the console (slice 9); staffing is open |
| R1-V5 | Message supplier for participant sign-in codes | Open | Not chosen; production sign-in is closed. Paid service, needs approval |

## 5. Security

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-S1 | SEC-01: administrators removing each other at the same moment (one succeeds, the other is a deadlock abort answered with 500) | Open | Deferred; blocks production and real staff use. Tests SEC-01-a to f in SECURITY_BACKLOG |
| R1-S2 | Every production gate in SECURITY_BACKLOG section 2 (database TLS and certificates, failed-statement logging, pooler, settings review, console network restriction and CSP, staff sign-in limit per address, sole-administrator recovery) | Open | Each gate needs evidence of closure |
| R1-S3 | Independent review or penetration test of the pilot surfaces | Open | Decision; paid service |
| R1-S4 | Secrets management in hosting: no secret in the repository, rotation procedure | Partial | No secrets committed so far; hosting procedure open |
| R1-S5 | Dependency and image vulnerability scanning in CI | Open | Not set up |
| R1-S6 | Staff accounts: real enrolment, two-factor devices, offboarding procedure | Partial | Built for test accounts (slice 8); procedure open |
| R1-S7 | Retention and removal of the carrier access log, the quotation read log and audit entries | Open | Unresolved production requirement; depends on R1-L5 |
| R1-S8 | The slice-4 unexplained API test failure is explained, and the PR #9 staging CI diagnosis is verified (now "inferred") | Open | Investigation |

## 6. Hosting

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-H1 | Hosting provider and region, consistent with R1-L5 | Open | Decision; paid service |
| R1-H2 | Separate production and staging environments, with production marked as such in the database | Partial | Environment marking exists; environments do not |
| R1-H3 | Managed PostgreSQL 16 with encrypted connections and certificate validation | Open | See R1-S2 |
| R1-H4 | Domain names, TLS certificates, DNS | Open | Decision; paid |
| R1-H5 | Deployment pipeline from `main` only, with manual approval | Open | No deployment exists. `main` stays untouched until authorised |
| R1-H6 | Staff console on a restricted network | Open | See R1-S2 |

## 7. Backups and restore

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-B1 | Backup method and frequency, and point-in-time recovery | Open | Decision with R1-H1 |
| R1-B2 | Recovery point and recovery time targets for the pilot | Open | Decision |
| R1-B3 | Backups encrypted and stored apart from the database | Open | |
| R1-B4 | A restore rehearsal into a clean environment, with the migrations checked and the application started on the restored data | Open | Must be done and recorded before launch |
| R1-B5 | Restore keeps audit and append-only logs intact | Open | Part of R1-B4 |

## 8. Monitoring

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-M1 | Uptime checks on `/health/live` and `/health/ready` | Partial | Endpoints exist (slice 1); no monitor |
| R1-M2 | Error tracking that never records personal data, tokens or statement parameters | Open | Decision on tool; paid |
| R1-M3 | Logs with request identifiers, retained per R1-L5 | Partial | Request identifiers exist; retention open |
| R1-M4 | Alerts for errors, database health, failed sign-ins and staff actions, and who receives them | Open | |
| R1-M5 | Pilot measures, defined before launch (for example quotations per published shipment) | Open | Decision; no figures assumed |

## 9. Support

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-U1 | Support channel and hours for pilot participants | Open | Decision |
| R1-U2 | Support procedures: account access, organisation changes, verification questions, disputes about a quotation | Open | Runbooks to write |
| R1-U3 | Staff read-only views are enough for support without database access | Partial | Console shows organisations, verification, shipments and quotations |
| R1-U4 | Reporting a security or privacy problem | Open | |

## 10. Recovery and incidents

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-I1 | Incident response plan: roles, severity levels, communication to participants | Open | |
| R1-I2 | Procedure to suspend a participant or the whole pilot quickly | Partial | Verification withdrawal suspends shipments (slices 9 and 10); a pilot-wide stop is not built |
| R1-I3 | Recovery of a lost staff administrator account | Open | Production gate; needs separate authorisation |
| R1-I4 | Personal data breach procedure, per R1-L5 | Open | |

## 11. User testing

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-T1 | Final audit backlog worked through: wording, translation (TR-01 to TR-16), accessibility | Open | FINAL_AUDIT_BACKLOG.md |
| R1-T2 | Native Arabic and Urdu review of all text, with a glossary | Open | TR-06 |
| R1-T3 | Screen-reader test (VoiceOver, TalkBack, NVDA) and physical phones, Safari and Firefox | Open | AX-02, AX-03 |
| R1-T4 | Moderated sessions with a few real shippers and carriers on the staging environment, with fictional data | Open | Needs participants and consent |
| R1-T5 | Staff walkthrough of verification and support in the console | Open | |

## 12. Rollback

| ID | Item | Status | Evidence or next step |
|---|---|---|---|
| R1-R1 | Application rollback to the previous release, rehearsed | Open | |
| R1-R2 | Database rule: migrations are forward-only, so a rollback is a new forward migration or a restore; every release states which | Partial | Forward-only rule exists |
| R1-R3 | Release switch: registration, publication and quotations can be closed in production without a deploy | Partial | Registration is closed by setting; publication and quotations follow country and verification configuration; a single pilot switch is not built |
| R1-R4 | Go/no-go meeting with this checklist, and who signs | Open | |

## Blocking order

Nothing can launch until R1-G1 to R1-G4, R1-L2, R1-L4, R1-V1, R1-V5, R1-S1, R1-S2, R1-H1, R1-B4 and R1-R4 are closed with evidence. The remaining items are needed for the pilot, but they can run in parallel with these.
