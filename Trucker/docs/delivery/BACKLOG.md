# Trucker initial backlog

Fresh implementation approved. Proposed implementation architecture follows the
original Plan B reference; vendor and release decisions remain open.

1. M0: runnable API/web/PostgreSQL foundation, configuration validation, migrations,
   health checks, documented setup and CI. Add reproducible helpers under tools/dev.
2. M1: real identity, organisations, memberships, scoped roles and staff MFA.
   Prove tenant isolation; implement shipper create/list with durable storage.
3. M2: carrier/owner profiles and compliance, fleet, offers/counteroffers,
   atomic booking and conflict-safe truck/trailer/driver reservation.
4. M3: Flutter driver app, assignment, milestones, consented location,
   durable offline queue, messaging and private POD upload/review.
5. M4: disputes, finance records/provider sandbox, reconciliation and
   versioned admin settings with two-person approval for financial changes.
6. M5: selected partner integration, reviewed EN/AR/UR flows, security,
   recovery/performance evidence, UAT, support runbooks and release preparation.
7. M6: approved controlled pilot, stabilization and remaining agreed mobile scope.

For every slice record requirement, acceptance criteria, changed files, relevant
test results and remaining limitations. Never claim production readiness from mocks.
