# TeamRadar Map

Discord의 **근태 채널 / 업무공유 채널** 데이터를 수집해 대시보드와 맵으로 시각화합니다.

## Quick Start

```bash
npm install
npm run collector:start
npm run dashboard:start
npm run map:serve
```

- Dashboard: `http://localhost:3100/dashboard`
- Map: `http://localhost:8765/composed_set_map.html`

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

## Discord 채널 병렬 작업 권장 매핑

- `#collector-dev` → `collector/` 중심 작업
- `#dashboard-dev` → `dashboard/` + `public/dashboard.html` 중심 작업
- `#map-frontend-dev` → `map-frontend/` 가이드 기반 `/workspace/map/composed_set_map.html` 작업

각 채널은 자기 영역 우선으로 수정하고, 공용 계약(API response/status enum) 변경 시에만 교차 리뷰를 권장합니다.

## GitHub 업로드 체크리스트

1. `.env`, `data/`, `node_modules/`가 커밋에 포함되지 않았는지 확인
2. `npm run dev:status`에서 dashboard/status API/map 모두 200 확인
3. 상태 계약 변경 시 `docs/PARALLEL_WORKFLOW.md` 업데이트
4. PR 설명에 트랙(collector/dashboard/map) 명시
