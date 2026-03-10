# TeamRadar Map

Discord의 **근태 채널 / 업무공유 채널** 데이터를 수집해 대시보드와 맵으로 시각화합니다.

## Quick Start

```bash
npm install
cp .env.example .env
# .env 값(토큰/채널ID/봇ID) 채우기

npm run collector:start
npm run dashboard:start
npm run map:serve
```

- Dashboard: `http://localhost:3100/dashboard`
- Map: `http://localhost:8765/composed_set_map.html`

---

## Environment Variables

주요 값만 먼저:

- `DISCORD_BOT_TOKEN` : Discord bot token
- `DISCORD_GUILD_ID` : 멤버 목록 조회용 guild id
- `ATTENDANCE_CHANNEL_IDS` : 근태 채널 ID 목록 (comma-separated)
- `WORK_CHANNEL_IDS` : 업무공유 채널 ID 목록 (comma-separated)
- `WANTEDSPACE_BOT_ID` : 출/퇴근 이벤트 소스 봇 ID
- `CHRONICLE_BOT_ID` : 연차/반차/재택 스케줄 소스 봇 ID

권장: `.env.example`를 복사해서 `.env`로 사용하세요.

```bash
cp .env.example .env
```

---

## Scripts

- `npm run collector:start` : Discord monitor 실행 (collector workspace entry)
- `npm run dashboard:start` : dashboard/API 실행 (dashboard workspace entry)
- `npm run map:serve` : map frontend 정적서버 실행 (`/workspace/map`, 8765)
- `npm run dev:up` : collector/dashboard/map 일괄 실행
- `npm run dev:status` : 3개 서비스 + HTTP 헬스체크
- `npm run dev:down` : 일괄 종료
- `npm run monitor:discord` : collector:start alias
- `npm run dashboard` : dashboard:start alias
- `npm run monitor:src` : src 경로 직접 실행
- `npm run dashboard:src` : src 경로 직접 실행
- `npm run db:migrate:pg` : JSON -> PostgreSQL 마이그레이션
- `npm run backfill:work` : work 로그 백필 스크립트
- `npm run backfill:attendance:schedule` : 최근 30일 근태 스케줄(연차/반차/재택 등) 백필

---

## Attendance Ingestion Rules (최신)

근태 이벤트는 지정된 소스 봇 메시지만 처리합니다.

- WantedSpace 봇(`WANTEDSPACE_BOT_ID`)
  - 허용 상태: `출근`, `퇴근`, `지각`, `복귀`, `자리비움`
- Chronicle 봇(`CHRONICLE_BOT_ID`)
  - 허용 상태: `재택근무`, `연차`, `반차`, `오전반차`, `오후반차`, `휴가`, `cancelled`

또한 스케줄 관련 메타(`scheduledFor`, `durationText`)를 이벤트에 저장합니다.

---

## DB Modes

- `DB_MODE=json` : JSON only
- `DB_MODE=dual` : JSON + PostgreSQL mirror writes
- `DB_MODE=postgres` : PostgreSQL-first

`DATABASE_URL`이 있고 `DB_MODE`를 지정하지 않으면 기본 `dual` 모드로 동작합니다.

## PostgreSQL Migration

```bash
psql "$DATABASE_URL" -f db/postgres/schema.sql
npm run db:migrate:pg
```

---

## Attendance Reload / Backfill APIs

- `POST /api/attendance/reload-today`
  - 오늘 근태 메시지 재수집
- `POST /api/attendance/reload-scheduled`
  - 과거 N일치 근태/스케줄 이벤트 재수집
  - body 예시: `{ "days": 7 }` (최대 30일)

---

## Collision Editor (v1)

대시보드의 `Collision Editor` 탭에서 충돌 오버라이드를 직접 편집할 수 있습니다.

- 맵 파일 위치: `public/assets/custom-map/*.png`
- 파일명 규칙:
  - 파일명에 `collision`이 **없으면** base map
  - 파일명에 `collision`이 **있으면** 해당 base map의 collision mask로 매칭
- 오버라이드 저장: `data/collision-overrides.json` (mapKey별 저장, gitignore 대상)
- 최종 충돌: `base mask + overrides(block/clear)`

### API

- `GET /api/map/collision/catalog` (base/collision 파일 자동 매칭 + 2x2 layout 정보)
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
├─ collector/                  # Discord 수집기 작업영역
│  ├─ index.js
│  └─ README.md
├─ dashboard/                  # Dashboard/API 작업영역
│  ├─ index.js
│  └─ README.md
├─ map-frontend/               # 맵 프론트 작업 가이드
│  └─ README.md
├─ public/
│  ├─ dashboard.html
│  ├─ assets/                  # character assets only
│  ├─ reports/
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
├─ data/                         # runtime JSON DB (gitignored)
├─ dashboard-server.js           # bootstrap entry
├─ discord-monitor.js            # bootstrap entry
└─ .env.example
```

---

## GitHub 업로드 체크리스트

1. `.env`, `data/`, `node_modules/`가 커밋에 포함되지 않았는지 확인
2. `npm run dev:status`에서 dashboard/status API/map 모두 200 확인
3. 상태 계약 변경 시 `docs/PARALLEL_WORKFLOW.md` 업데이트
4. PR 설명에 트랙(collector/dashboard/map) 명시
