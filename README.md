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
- Map (권장): `http://localhost:3100/map/composed_set_map.html`
- Map (독립 서버): `http://localhost:8765/composed_set_map.html`

> `map:serve`는 `team_radar/map` 경로를 8765로 정적 서빙합니다.
> 대시보드 서버(3100)에서도 `/map/*` 라우트로 같은 맵 파일을 제공합니다(단일 포트 운영 권장).

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
- `DASHBOARD_HOST` : 대시보드 바인드 인터페이스 (기본 `0.0.0.0`, 로컬 전용은 `127.0.0.1`)
- `MAP_HOST` : `map:serve` 정적 서버 바인드 (기본 `0.0.0.0`)
- `MAX_WORK_LOGS_PER_USER` : 사용자별 최근 업무 로그 보관 개수
- `STARTUP_ATTENDANCE_BACKFILL`, `ATTENDANCE_BACKFILL_DAYS_KST`
- `STARTUP_WORK_BACKFILL`, `WORK_BACKFILL_DAYS`
- `ATTENDANCE_NAME_LOOKBACK_DAYS`
- `DB_MODE`, `DATABASE_URL` (PostgreSQL 사용 시)
- `APP_ACCESS_TOKEN` (설정 시 `/login` 기반 접근 제어 활성화 — 자세한 내용은 [Access & Security](#access--security-optional))
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

## Access & Security (Optional)

### 토큰 로그인 게이트

`APP_ACCESS_TOKEN`을 `.env`에 설정하면 인증이 활성화됩니다.

- 로그인 페이지: `/login`
- 로그인 성공 후 기본 이동: `/map/composed_set_map.html`
- 보호 대상: `/map/*`, `/dashboard.html`, `/api/*` 등 주요 경로

```env
APP_ACCESS_TOKEN=change-this-to-a-long-random-token
```

설정하지 않으면 기존처럼 인증 없이 접근합니다.

- 인증이 켜져 있을 때, collector의 주기적 재동기화(`ATTENDANCE_PERIODIC_RESYNC_*`)는
  같은 토큰을 `x-access-token` 헤더로 전송해 대시보드 API에 접근합니다.
  즉 대시보드와 collector에 **동일한 `APP_ACCESS_TOKEN`**을 설정해야 재동기화가 동작합니다.

### 네트워크 노출 주의

> ⚠️ 기본 설정(`APP_ACCESS_TOKEN` 미설정)에서는 대시보드가 **모든 인터페이스(`0.0.0.0`)**에
> 바인딩되며 인증 없이 열립니다. 이 경우 같은 네트워크의 누구나 근태 데이터 조회 및
> 상태/매핑/맵 오버라이드 **쓰기 API**를 호출할 수 있습니다.

권장 설정:

- 로컬 전용으로 쓰려면: `DASHBOARD_HOST=127.0.0.1`
- 사무실/타임넷 등 네트워크에 노출하려면: 반드시 `APP_ACCESS_TOKEN`을 설정
- 서버 기동 시 `0.0.0.0` + 토큰 미설정이면 `[SECURITY]` 경고를 출력합니다.
- `npm run map:serve`(포트 8765) 정적 서버는 **인증이 없습니다.** 로컬 전용은
  `MAP_HOST=127.0.0.1`로 바인딩하거나, 인증이 적용되는 대시보드의 `/map/*` 경로를 사용하세요.
- 대시보드는 `Access-Control-Allow-Origin: *`(CORS 와일드카드)를 사용합니다.
  이는 다른 포트(8765)에서 `?apiBase=`로 API/맵 이미지를 크로스 오리진으로 불러오는
  워크플로를 위한 것입니다. 노출 환경에서는 반드시 토큰 인증과 함께 사용하세요.

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

두 위치가 있으니 혼동하지 마세요.

- `public/reports/` : 런타임 산출물 위치. `.gitignore` 대상이라 **커밋되지 않습니다.**
- `reports/` (레포 루트) : 커밋되어 있는 진행 리포트 HTML(`progress-update-*.html`).
  - ⚠️ 현재 이 폴더에는 수 MB 규모의 대용량 HTML이 포함되어 있어 클론 용량을 키웁니다.
    새 산출물은 가급적 `public/reports/`(gitignore)에 두거나 별도 저장소/배포 채널로 공유하세요.
- 공유용 산출물은 필요 시 별도 경로/저장소에 보관하거나, 배포 채널에서 직접 전달하세요.

---

## Project Layout

```text
teamradar-map/
├─ src/
│  ├─ core/
│  │  ├─ paths.js
│  │  └─ pg-store.js
│  ├─ shared/
│  │  ├─ attendance-parse.js   # 근태/업무 메시지 파서 (collector·dashboard 공용)
│  │  └─ status-zones.js       # 상태 → 맵 구역 매핑
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

---

## 향후 과제 & 방향성 (Roadmap)

> 이 프로젝트는 계속 다듬어가는 내부 도구입니다. 아래는 "여기서 더 좋아지려면"에 대한
> 열린 메모입니다. 우선순위는 상황에 맞게 조정하세요.

### 남은 개선 과제 (구체적, 착수 가능)

- **리포트 아티팩트 정리** — 루트 `reports/`에 대용량 HTML(~12MB, 9.8MB 파일 포함)이
  커밋되어 클론 용량을 키웁니다. `.gitignore` 이전 / 별도 저장소 / Git LFS 중 하나로
  정리하고, 새 산출물은 `public/reports/`(gitignore)로 유도.
- **근태 판정 의미 확정** — `applyEffectiveAttendance`의 반차+재택 동시 케이스가
  비대칭입니다(오후반차만 재택을 반영, 오전반차/반차는 무조건 휴가). "반차 + 오후 재택 +
  출근 체크인" 같은 조합 상태의 표시 규칙을 제품 관점에서 정하고 대칭 적용.
- **백필 요약 일관성** — 시작 시 업무 백필이 `summaryShort`를 단순 절삭으로 채워 LLM
  재요약 대상에서 제외됩니다. 라이브 메시지와 요약 품질을 일치시키기.
- **로그 total 계약 통일** — `/api/team/logs`의 `totalEvents`가 DB 모드/`hideBots`에 따라
  "전체 개수"와 "페이지 개수"로 의미가 달라집니다. 계약을 통일하거나 명시적으로 문서화.
- **헬스체크 라우트 추가** — `/healthz`가 인증 화이트리스트에는 있으나 실제 라우트가 없어
  404입니다. 실제 헬스 엔드포인트를 추가해 운영 모니터링/`dev:status`를 강화.
- **프론트엔드 렌더 안정성 점검** — 맵(`map/composed_set_map.html`)의 DPR 리사이즈 시
  캔버스 재할당, 스프라이트 로드 실패 캐시, 알림 배지 정리 등 장시간 구동 견고성 점검.

### 방향성 (열린 결말)

- **실시간화** — 폴링 대신 WebSocket/SSE로 상태 push. 맵/대시보드 갱신 지연과 부하를 줄이고,
  근태/업무 변화가 즉시 반영되는 경험으로.
- **저장소 모드 수렴** — `json`/`dual`/`postgres` 3모드를 유지하는 비용이 큽니다.
  Postgres-first를 정본으로 삼고 스크립트/경로를 일원화, JSON은 로컬 개발 편의용으로 축소.
- **테스트 도입** — 이번에 통합한 공용 파서(`src/shared/attendance-parse.js`)를 시작점으로
  파서/근태 판정 단위 테스트를 붙이면 회귀를 자동으로 막을 수 있습니다. 실제 메시지 샘플을
  픽스처로 축적.
- **보안 기본값 승격** — 노출 환경을 전제로 `APP_ACCESS_TOKEN` + 로컬 바인딩을 "권장 기본"으로
  올리고, 쓰기 API에 CSRF/레이트리밋을 검토.
- **이벤트 반영 확장** — 메시지 수정/삭제 이벤트까지 반영해 상태 정확도를 높이기.
- **파싱 고도화** — 신규 상태(예: `조퇴`)나 채널별 템플릿이 필요할 때 공용 파서 한 곳만
  고치면 collector·dashboard가 동시에 반영됩니다(이미 구조는 마련됨).
