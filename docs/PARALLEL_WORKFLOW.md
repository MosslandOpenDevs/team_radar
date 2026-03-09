# Parallel Workflow Guide

이 프로젝트는 3개 트랙 병렬 작업을 전제로 합니다.

## 1) Collector Track
- 경로: `collector/`, `src/modules/monitor/collector.js`
- 책임: Discord 수집/파싱, 상태 분류, 저장
- 채널 권장: `#collector-dev`

## 2) Dashboard Track
- 경로: `dashboard/`, `src/modules/dashboard/server.js`, `public/dashboard.html`
- 책임: API + 운영 UI + 매핑 기능
- 채널 권장: `#dashboard-dev`

## 3) Map Frontend Track
- 경로: `map-frontend/`, `/workspace/map/composed_set_map.html`
- 책임: 캐릭터 배치/렌더링/시각화
- 채널 권장: `#map-frontend-dev`

---

## Shared Contract (중요)

변경 시 교차 리뷰가 필요한 항목:
- `/api/team/status` 응답 형태
- `/api/map/status-room-mapping` 형식
- 상태 enum: `working`, `offwork`, `remote`, `vacation`

상태 키/응답 스키마를 변경하면 반드시 3트랙 동시 공지 + 리뷰하세요.

## Local Dev

```bash
npm run dev:up
npm run dev:status
npm run dev:down
```

## Merge Rules (권장)

- 트랙별 PR 분리 (collector/dashboard/map)
- 공통 계약 변경 PR은 `contract-change` 라벨
- `dev:status` 기준 health 200 확인 후 머지
