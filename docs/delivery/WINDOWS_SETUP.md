# Windows setup

**Verified on a GitHub Windows runner, not on a desktop PC.** The CI job `windows` follows
option B below on every pull request: checkout, install, checks, tests, migrate, start the API
and call it. That runner provides PostgreSQL 17, not 16. Option A (Docker Desktop), the
PostgreSQL 16 installer and a real Windows desktop are **not verified**. Record what happens
on the first desktop run and correct this file.

## Prerequisites

| Need | Notes |
|---|---|
| Git for Windows | Line endings are fixed by `.gitattributes`; no `core.autocrlf` setting is required |
| Node.js 22.x (22.12 or later) | Installer from nodejs.org, or a version manager. `node -v` must print v22. npm 10.9 or later comes with it |
| PostgreSQL 16 | Either Docker Desktop (option A) or the PostgreSQL 16 installer (option B) |
| PowerShell | Commands below are PowerShell. Do not run it elevated |

Clone into a short path such as `C:\src\trucker` to stay clear of path-length limits.

## Option A: database in Docker Desktop

```powershell
docker compose -f tools/dev/docker-compose.yml up -d
docker compose -f tools/dev/docker-compose.yml ps     # wait for "healthy"
```

## Option B: database installed on Windows

Install PostgreSQL 16, then create the local role and database once (you will be asked for the
`postgres` password chosen during installation):

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE ROLE trucker LOGIN CREATEDB CREATEROLE PASSWORD 'trucker-local-only'"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE trucker_dev OWNER trucker"
```

`CREATEDB` is needed because each test file creates and drops its own database. `CREATEROLE` is
needed because the migrations create the role the API runs as (`trucker_app`) and
`npm run db:app-role` creates a local login for it. A role created before 13 November 2026 lacks
it: run `ALTER ROLE trucker CREATEROLE` once, as `postgres`.

After `npm run db:migrate` (or `npm run dev:migrate`), run `npm run db:app-role` (or
`npm run dev:app-role`). It prints the `APP_DATABASE_URL` the API must use; `.env.example`
already holds that value. Without it the API connects as the migration role and keeps
organisation data closed.

## Install, check and run

```powershell
cd C:\src\trucker
npm ci
$env:NODE_ENV = "test"
$env:DATABASE_URL = "postgres://trucker:trucker-local-only@localhost:5432/trucker_dev"
npm run verify          # format check, lint, type check, migration file check, tests
npm run db:migrate      # apply migrations before starting the API
npm run db:status       # must report pending: 0, problems: 0
$env:NODE_ENV = "development"
npm run start:api
```

The helper commands work the same on Windows: `npm run dev:doctor` checks the prerequisites,
`npm run dev:env` creates `.env`, and `npm run dev:migrate`, `npm run dev:verify` and
`npm run dev:api` use the values in `.env` instead of `$env:` variables. `npm run dev:db:up`
needs Docker and was not run on Windows.

In a second PowerShell window:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

Environment variables set with `$env:` last for that PowerShell window only. Copy
`.env.example` to `.env` with `npm run dev:env` if you prefer the `dev:*` commands: the API does
not read `.env` itself, but those commands do.

## Known points to watch on Windows

| Point | Detail |
|---|---|
| Line endings | SQL files check out with LF (confirmed on the Windows runner). Checksums are also computed on normalised text, so a CRLF copy gives the same checksum |
| Killed-runner test | One test stops a child process abruptly. It passes on the Windows runner |
| Port 5432 in use | A PostgreSQL service already installed on Windows conflicts with the Docker database. Use one option, not both |
| Antivirus or indexing | Can slow `npm ci`; no workaround is needed for correctness |
