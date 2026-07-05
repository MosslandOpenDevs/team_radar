# TeamRadar Architecture

## Runtime

- `discord-monitor.js` → `src/modules/monitor/collector.js`
- `dashboard-server.js` → `src/modules/dashboard/server.js`

Bootstrap files at repo root are intentionally kept for backward compatibility with existing run commands.

## Source Layout

- `src/core/`
  - `paths.js`: project path constants
  - `pg-store.js`: PostgreSQL adapter/store
- `src/shared/`
  - `attendance-parse.js`: single source of truth for attendance/work message
    parsing (`parseAttendanceState`, `parseWorkState`, `extractAttendanceName`,
    `extractScheduleInfo`, `getMessageText`). Imported by both the collector
    (live ingestion) and the dashboard (reload/backfill) so the same Discord
    message is always classified identically regardless of ingestion path.
  - `status-zones.js`: status → map-zone mapping + normalization
- `src/modules/monitor/`
  - Discord ingestion, parsing, event append, status update
- `src/modules/dashboard/`
  - HTTP API + dashboard serving + mapping endpoints

## Data Modes

- `DB_MODE=json` : JSON only (`data/team-status-db.json`)
- `DB_MODE=dual` : JSON + PostgreSQL mirror writes, dashboard reads from PostgreSQL
- `DB_MODE=postgres` : PostgreSQL-first mode

If `DATABASE_URL` is present and `DB_MODE` is not specified, mode defaults to `dual`.

## Static/Public

- `public/dashboard.html`: dashboard UI
- Map UI는 별도 경로(`map/composed_set_map.html`)에서 운영
- `public/assets/`: sprites, map assets
- `public/reports/`: runtime HTML reports (**gitignored**)
- `reports/` (repo root): committed progress-report HTML (large; see README > Reports)
- `public/lab/`: playground/check tools
- `public/portable/`: portable snippets/assets

## DB & Migration

- `db/postgres/schema.sql`: PostgreSQL schema
- `scripts/migrate-json-to-postgres.js`: one-shot migration JSON -> PostgreSQL
- `scripts/backfill-work-logs.js`: work log backfill utility
