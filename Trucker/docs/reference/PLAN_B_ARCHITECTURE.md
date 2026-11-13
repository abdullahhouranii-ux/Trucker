# TruckLink Plan B — Independent Platform (Prototype v2)

## Target architecture
- Flutter applications: shipper, carrier, driver, independent vehicle owner. Shippers and carriers also have responsive Next.js web portals.
- Next.js operations console: dispatch, finance, customer support, compliance, integrations, administrative settings.
- NestJS TypeScript modular monolith: identity, organisations, fleet, shipments, offers, bookings, dispatch, trip events, documents, payments, notifications, integrations, audit.
- PostgreSQL + PostGIS as transaction and geospatial store. Redis/BullMQ for durable background tasks; object storage for signed POD and documents; WebSocket event gateway for tracking and messaging.
- Licensed payment provider for authorization/capture/refund; never describe platform-held funds as escrow unless licensing and legal structure permit it.

## Profiles and permissions
- Shipper organisation: legal entity, trade licence, users, pickup/delivery locations, billing terms, approved integrations.
- Carrier organisation: business registration, transport permits, insurance, dispatchers, trucks, trailers, drivers, bank/payment details.
- Independent vehicle owner: identity or business registration, vehicle/trailer ownership, permits, driver delegation, payout details.
- Driver: identity, driving licence class/expiry, employer/owner relationship, trip assignments, consent for location processing.
- Operations administrator: staff identity, MFA, granular privileges, approvals and immutable audit records.
- Enforce organisation-level row isolation server-side; drivers see only assigned trips, vehicle owners only owned/authorised assets; finance and settings require dedicated permission scopes.

## Transaction states
Load: draft → published → offered → booked → dispatched → picked_up → in_transit → delivered → POD_review → closed. Cancellation, exception and dispute states are separate controlled transitions.
Offer: submitted → countered → accepted/rejected/expired.
Payment: initiated → authorized/paid → settlement_pending → settlement_eligible → settled; disputed/failed/refunded are explicit transitions.

## Assignment rules
A booking must atomically reserve a compatible truck, trailer (if required), and driver for the time interval. Verify permit validity, equipment capacity, driver licence, availability and organisation authorization. Prevent overlapping assignments via transactional constraints and concurrency tests.

## Conditional payment rules
Offer configurable prepaid, approved-deposit-plus-POD, or approved-POD payment terms. Settlement eligibility is not equivalent to funds release. Verify POD and contractual disputes before provider-controlled disbursement; implement idempotent webhook processing and reconciliation. All live payment terms require legal and gateway review.

## Enterprise integration
TruckLink team onboards shipper ERP and carrier TMS integrations. OAuth2 scoped credentials, mTLS where applicable, signed webhooks, versioned REST, idempotency keys, rate limits, audit logging and sandbox credentials. No secrets in client apps. Example endpoints: POST /v1/shipments, GET /v1/shipments/{id}, POST /v1/offers, POST /v1/bookings, POST /v1/trips/{id}/milestones, GET /v1/settlements.

## Admin settings (added in v2)
- Marketplace: commission percentage, currency, negotiation policy.
- Payments: settlement trigger, POD requirement, review window.
- Compliance: verification requirements, auto-dispatch toggle, GPS interval.
- Integrations: API onboarding and webhook enablement.
- Notifications: email and mobile push preferences.
Production settings require scoped authorization, dual approval for sensitive financial changes, versioning, change history, rollback, validation, and secrets stored in a vault. Demo settings only exist in browser memory.

## Phased delivery
1. Validate Oman licensing, payment and data-hosting rules; confirm user journeys and customer pilots.
2. Build identity, organisation profiles, fleet/driver compliance and RBAC.
3. Build load requests, quotation negotiation, booking and conflict-safe dispatch.
4. Add driver milestones, tracking, chat, offline sync and POD review.
5. Add payment orchestration, finance reconciliation, admin settings and audit.
6. Add shipper/carrier APIs, sandbox, webhooks, monitoring and pilot hardening.

## Acceptance gates
- Arabic/English role-specific flows and RTL; mobile and web responsiveness.
- No cross-tenant reads/writes or unauthorized admin changes.
- Concurrent bookings cannot allocate the same truck, trailer or driver for overlapping windows.
- Expired documents block dispatch according to approved policy.
- Payment webhooks are idempotent; disputes stop settlement eligibility.
- API failures retry safely and produce actionable integration alerts.
- Offline driver events sync once and in correct order.
- Demo prototype never claims to execute a live transaction.

