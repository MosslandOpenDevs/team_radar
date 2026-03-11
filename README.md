# TeamRadar Map

Discord의 **근태 채널 / 업무공유 채널** 데이터를 수집해서,
대시보드와 맵 형태로 팀 상태를 시각화합니다.

---

## Quick Start

```bash
npm install
cp .env.example .env
# .env 값(토큰/채널/봇 ID 등) 채우기

npm run collector:start
npm run dashboard:start
npm run map:serve
```

- Dashboard: `http://localhost:3100/dashboard`
- Map: `http://localhost:8765/composed_set_map.html`

> `map:serve`는 `team_radar/map` 경로를 정적으로 서빙합니다.

---

## Environment Variables

필수/핵심 값:

- `DISCORD_BOT_TOKEN` : Discord bot token
- `DISCORD_GUILD_ID` : 대시보드 멤버 목록 조회용 guild id
- `ATTENDANCE_CHANNEL_IDS` : 근태 채널 ID 목록 (comma-separated)
- `WORK_CHANNEL_IDS` : 업무공유 채널 ID 목록 (comma-separated)
- `WANTEDSPACE_BOT_ID` : 출퇴근 이벤트 소스 봇 ID
- `CHRONICLE_BOT_ID` : 연차/반차/재택 스케줄 소스 봇 ID

운영/옵션 값:

- `COMMAND_CHANNEL_IDS` : `!teamstatus`, `!teamlogs` 명령 허용 채널 제한
- `DASHBOARD_PORT` : 대시보드 포트 (기본 3100)
- `MAX_WORK_LOGS_PER_USER` : 사용자별 최근 업무 로그 보관 개수
- `STARTUP_ATTENDANCE_BACKFILL`, `ATTENDANCE_BACKFILL_DAYS_KST`
- `STARTUP_WORK_BACKFILL`, `WORK_BACKFILL_DAYS`
- `ATTENDANCE_NAME_LOOKBACK_DAYS`
- `DB_MODE`, `DATABASE_URL` (PostgreSQL 사용 시)
- `APP_ACCESS_TOKEN` (설정 시 `/login` 기반 접근 제어 활성화)
- `DASHBOARD_API_BASE`, `ATTENDANCE_PERIODIC_RESYNC_*`
- `WORK_SUMMARY_*`, `OLLAMA_*`, `GEMINI_*` (업무 요약 생성 옵션)

권장: `.env.example`를 복사해서 `.env` 생성 후 사용

```bash
cp .env.example .env
```

---

## Scripts

- `npm run collector:start` : Discord monitor 실행 (collector workspace entry)
- `npm run dashboard:start` : dashboard/API 실행 (dashboard workspace entry)
- `npm run map:serve` : map frontend 정적 서버 실행 (`team_radar/map`, 8765)
- `npm run dev:up` : collector/dashboard/map 일괄 실행
- `npm run dev:status` : 3개 서비스 + HTTP 헬스체크
- `npm run dev:down` : 일괄 종료
- `npm run monitor:discord` : `collector:start` alias
- `npm run dashboard` : `dashboard:start` alias
- `npm run monitor:src` : src 경로 직접 실행
- `npm run dashboard:src` : src 경로 직접 실행
- `npm run db:migrate:pg` : JSON → PostgreSQL 마이그레이션
- `npm run backfill:work` : 업무 로그 백필
- `npm run backfill:attendance:schedule` : 최근 30일 근태 스케줄(연차/반차/재택 등) 백필

---

## Attendance Ingestion Rules

근태 이벤트는 **지정된 소스 봇 메시지만** 처리합니다.

- WantedSpace 봇 (`WANTEDSPACE_BOT_ID`)
  - 허용 상태: `출근`, `퇴근`, `지각`, `복귀`, `자리비움`
- Chronicle 봇 (`CHRONICLE_BOT_ID`)
  - 허용 상태: `재택근무`, `연차`, `반차`, `오전반차`, `오후반차`, `휴가`, `cancelled`

또한 이벤트에 스케줄 메타를 저장합니다:

- `scheduledFor`
- `durationText`

---

## Access Control (Optional)

`APP_ACCESS_TOKEN`을 `.env`에 설정하면 인증이 활성화됩니다.

- 로그인 페이지: `/login`
- 로그인 성공 후 기본 이동: `/map/composed_set_map.html`
- 보호 대상: `/map/*`, `/dashboard.html`, `/api/*` 등 주요 경로

```env
APP_ACCESS_TOKEN=change-this-to-a-long-random-token
```

설정하지 않으면 기존처럼 인증 없이 접근합니다.

---

## Attendance Reload / Backfill APIs

- `POST /api/attendance/reload-today`
  - 오늘 근태 메시지 재수집
- `POST /api/attendance/reload-scheduled`
  - 과거 N일치 근태/스케줄 이벤트 재수집
  - body 예시: `{ "days": 7 }` (최대 30일)

---

## Collision Editor

대시보드 `Collision Editor` 탭에서 충돌 오버라이드를 직접 편집할 수 있습니다.

- 맵 파일 위치: `public/assets/custom-map/*.png`
- 파일명 규칙:
  - 파일명에 `collision`이 **없으면** base map
  - 파일명에 `collision`이 **있으면** 해당 base map의 collision mask로 매칭
- 오버라이드 저장: `data/collision-overrides.json` (gitignore 대상)
- 최종 충돌: `base mask + overrides(block/clear)`

### API

- `GET /api/map/collision/catalog`
- `GET /api/map/collision/overrides?mapKey=<key>`
- `POST /api/map/collision/overrides?mapKey=<key>`
- `POST /api/map/collision/overrides/reset?mapKey=<key>`
- `GET /api/map/collision/effective?mapKey=<key>`

### Editor Controls

- 좌클릭: `block` 토글
- 우클릭: `clear` 토글
- 브러시: `1x1`, `3x3`
- Save / Revert / Reset to Mask
- Import / Export JSON

---

## DB Modes

- `DB_MODE=json` : JSON only
- `DB_MODE=dual` : JSON + PostgreSQL mirror writes
- `DB_MODE=postgres` : PostgreSQL-first

`DATABASE_URL`이 있고 `DB_MODE`를 지정하지 않으면 기본 `dual` 모드로 동작합니다.

### PostgreSQL Migration

```bash
psql "$DATABASE_URL" -f db/postgres/schema.sql
npm run db:migrate:pg
```

---

## Reports (중요)

- 리포트 기본 위치: `public/reports/`
- 이 폴더는 `.gitignore`에 포함되어 있어 **기본적으로 커밋/푸시되지 않습니다.**
- 공유용 산출물은 필요 시 별도 경로/저장소에 보관하거나, 배포 채널에서 직접 전달하세요.

---

## Project Layout

```text
teamradar-map/
├─ src/
│  ├─ core/
│  │  ├─ paths.js
│  │  └─ pg-store.js
│  └─ modules/
│     ├─ monitor/collector.js
│     └─ dashboard/server.js
├─ collector/
├─ dashboard/
├─ map/
│  ├─ composed_set_map.html
│  ├─ layered_map.html
│  └─ office_map.html
├─ public/
│  ├─ dashboard.html
│  ├─ assets/
│  ├─ reports/                  # gitignore 대상
│  ├─ lab/
│  └─ portable/
├─ db/postgres/schema.sql
├─ scripts/
│  ├─ migrate-json-to-postgres.js
│  ├─ backfill-work-logs.js
│  ├─ backfill-attendance-schedule.js
│  ├─ normalize-animations.js
│  └─ slice-characters-v5.js
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ PARALLEL_WORKFLOW.md
│  └─ discord-monitor-legacy.md
├─ data/                        # runtime JSON DB (gitignore)
├─ dashboard-server.js
├─ discord-monitor.js
└─ .env.example
```

---

## GitHub 업로드 체크리스트

1. `.env`, `data/`, `node_modules/`, `public/reports/`가 커밋되지 않았는지 확인
2. `npm run dev:status`에서 dashboard/status API/map 모두 200 확인
3. 상태 계약 변경 시 `docs/PARALLEL_WORKFLOW.md` 업데이트
4. PR 설명에 변경 트랙(collector/dashboard/map/docs) 명시
