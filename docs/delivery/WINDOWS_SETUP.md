# Windows setup

**Not executed on Windows.** These steps were written from the Linux setup and have not been
run on a Windows machine. Record what happens on the first run and correct this file.

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
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE ROLE trucker LOGIN CREATEDB PASSWORD 'trucker-local-only'"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE trucker_dev OWNER trucker"
```

`CREATEDB` is needed because each test file creates and drops its own database.

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

In a second PowerShell window:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

Environment variables set with `$env:` last for that PowerShell window only. Copy
`.env.example` to `.env` (`Copy-Item .env.example .env`) only as a reference: the API does not
read `.env` files itself.

## Known points to watch on Windows

| Point | Detail |
|---|---|
| Line endings | SQL files check out with LF. Checksums are also computed on normalised text, so a CRLF copy gives the same checksum (tested on Linux by simulating a CRLF checkout) |
| Killed-runner test | One test stops a child process abruptly. It is written with a portable call, but its behaviour on Windows is unverified |
| Port 5432 in use | A PostgreSQL service already installed on Windows conflicts with the Docker database. Use one option, not both |
| Antivirus or indexing | Can slow `npm ci`; no workaround is needed for correctness |
