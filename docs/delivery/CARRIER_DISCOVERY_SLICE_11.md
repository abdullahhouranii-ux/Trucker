# Trucker: carrier onboarding and discovery slice 11, record

Date: 15 November 2026. Branch `feat/carrier-discovery`, from staging at `1eaf3f2`. Scope and decisions: `CARRIER_DISCOVERY_SLICE_11_SCOPE.md` (CB-1 to CB-8 as recommended, with the clarifications in its section 5a; CAR-1 to CAR-13).

Test accounts and fictional data only. Carrier evidence requirements are fictional and exist only in databases marked for local development or tests. No quotation, price, fee, booking or payment exists. No launch country or lane is chosen.

## 1. What was built

| Part | Where |
|---|---|
| Carrier capability, carrier applications with declared service, identity-bound capabilities, per-capability withdrawal, discovery functions, access log, staff read | `db/migrations/0009_carrier_discovery.sql` |
| Fictional carrier requirements (XA, XB) | `db/fixtures/local-development/countries.json` |
| Verification API: capability and service on submission; per-capability state; `mayApply`, `mayDiscover` | `apps/api/src/verification/` |
| Discovery routes `GET /organisations/:id/discovery`, `.../discovery/shipments`, `.../discovery/shipments/:shipmentId` | `apps/api/src/discovery/` |
| Staff: revoke takes a capability; `GET /staff/shipments/:id/carrier-access` | `apps/api/src/staff/` |
| Carrier page (status, declared service, application, change of service), shipper application for a verified carrier, discovery list and detail, in English, Arabic and Urdu | `apps/web/src/app/[locale]/organisations/[id]/carrier`, `.../discover`, `verification` |
| Console: capability in the queue and on applications, declared service, held capabilities, withdrawal per capability, carrier access on the shipment page | `apps/console/src/app/verification`, `shipments/[id]` |

## 2. How it works

**Two independent capabilities (CB-2).** `ship` and `carry_as_company` each have their own application, decision, grant and withdrawal. Applications now have three kinds: `initial` (the organisation is not verified and applies with its identity for one capability), `capability` (a verified organisation applies for the other capability, or a carrier for a new declared service) and `amendment` (a change of legal identity). Deciding or withdrawing one capability never changes the other. The organisation stops being verified only when it holds no capability any more.

**The shared legal identity.** Every capability rests on the identity of the application that granted it. A capability counts (`capability_effective`) only while that identity is still the organisation's own, so no change of identity can silently carry a capability with it. An amendment records the capabilities held when it is submitted (`revalidates`) and must answer the evidence requirements of every one of them in the new country; a document asked for by both is answered once. Approved, it changes the identity and, in the same transaction, revalidates each capability on it, with one `capability.revalidated` history entry per capability recording the old and new identity. It cannot be approved for one capability and not the other: the reviewer requests changes or rejects, and the approved identity stays in force for both. A carrier's declared service is carried forward unchanged. Tested: approval, refusal, and an identity changed directly by the migration role, after which neither capability counts.

**Declared service (CB-3, CB-4).** A carrier application declares countries and equipment types from the database's own registers. They are stored as matching criteria, labelled so in the database, the API (`kind: declared_matching_criteria`), the carrier's pages and the console: not verified vehicles, not availability, not permission to accept work. A change is a new application; until staff decide it, the decided declaration stays in force.

**Discovery and eligibility (CAR-4, CAR-5, CAR-7).** Every list and detail request takes the carrier organisation's lock, then reads the clock, then judges, with nothing cached:
- the caller is an administrator of the selected organisation (CB-6);
- the carrier capability is effective;
- the shipment is published, before its deadline by the clock (whether or not the expiry is recorded) and has no open suspension;
- its shipper may still publish and its route is open now;
- it is not the carrier's own;
- both its countries and its equipment type are in the carrier's declaration.

A shipment that fails any condition answers exactly like one that does not exist. An organisation that is not a carrier gets the same refusal for every shipment, real or not. Discovery records nothing about shipments themselves. API answers carry `Cache-Control: no-store` and `Vary: Authorization`; the web pages are rendered per request, and the browser checks confirm `no-store`.

**Snapshot and cursor rules (CAR-13).**
- A list traversal starts at its first page; that moment is its anchor, carried in the cursor.
- Order is (deadline, id). The deadline used is the one in the shipment's latest version published at or before the anchor; a shipment first published after the anchor is ordered by its current deadline. A deadline changed during the traversal therefore does not move the shipment, so it is neither duplicated nor skipped. Its current deadline is shown, marked "changed since this list was started". A version made at the anchor's exact instant counts as before it.
- Every page shows only what is eligible at that page's moment. A shipment withdrawn, expired, suspended or no longer matching disappears even if an earlier page showed it.
- A shipment published after the anchor with a deadline before the position reached is not shown in that traversal; a new traversal shows it.
- A cursor carries no shipment content: version, organisation, a hash of the filter, the anchor, the last deadline and the last identifier. It is refused when used by another organisation or with another filter (400), when malformed or set in the future (400), and after `discovery_cursor_hours` (409). After a revocation, reusing a cursor gets the same refusal as any other request (403).

**Access log (CB-7).** `carrier_access_log` holds who read, when, list or detail, the outcome (shown, not found, refused), the shipment identifiers shown and the filter codes, never a description, area, address or contact. A trigger refuses every update, delete and truncate, for every role. The API's role has no right on it. Staff with a review privilege read it per shipment through the console, and each look is recorded in the staff audit. The shipper is not told who looked. Retention is an unresolved production requirement (SECURITY_BACKLOG.md).

**Read limit.** Reads per carrier organisation in any 60 seconds are counted from the log and limited by a protected setting (development default 120). A refusal is logged.

**Correction on the shipper side.** The preview said no carrier could see a shipment. Once carriers can, that is untrue: the preview, the shipment page and the console now say that verified carriers whose declared service matches see exactly the projection. This is a correctness change; other wording stays with the final audit.

## 3. Routine choices made during the build

- One open application per organisation at a time, as in slice 9; a carrier application waits for an open shipper application or amendment.
- A verified carrier applies for the shipper capability on the verification page; the carrier capability has its own page.
- The `capability` field of an amendment names the first capability it revalidates; `revalidates` is authoritative.
- The staff revoke route now requires `capability`.
- Settings: `discovery_page_size` 20, `discovery_read_limit` 120 per minute, `discovery_cursor_hours` 2.

## 4. Checks run (local)

| Check | Result |
|---|---|
| `npm run verify` | Passed |
| API tests | 265 passed, 0 failed, 1 marked todo (SEC-01); 17 new discovery tests; verification, publication, organisation and hardening tests updated for the new functions, tables and revoke body |
| Web browser checks | 1,480 checks, 0 failed: carrier application, a lost carrier-application answer, discovery list, filter, detail, `no-store`, shipper refused, suspended shipment gone; carrier and discovery screens inspected in three languages |
| Console browser checks | 211 checks, 0 failed |
| Defect injection | Ten defects put into 0009 one at a time: no identity binding, no suspension or shipper check, no cursor organisation check, no deadline check, own shipments shown, amendment not revalidating, access log not append-only, ordering not anchored, organisation left verified after its last capability, no equipment matching. Each made at least one test fail. Restored byte for byte |

## 5. Not verified, and limits

- The browser checks cover a lost answer to a carrier application. A lost change of declared service, and revocation from the console per capability, are covered by API tests and the console's existing withdrawal check, not by a browser lost-answer check.
- A request delayed behind a lock on the shipment itself is not tested: discovery reads shipments without locking them, so a withdrawal committing during a read is seen at the next request.
- Screen readers were not used. Arabic and Urdu are drafts (TR-14).
- SEC-01 stays deferred and blocks production and real staff use.
