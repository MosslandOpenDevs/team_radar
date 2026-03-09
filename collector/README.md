# Collector workspace

Discord 수집기 전용 작업 폴더입니다.

## 담당 범위
- Discord 메시지 수집/파싱
- 근태/업무 상태 분류
- DB(JSON/Postgres) 반영

## 주요 진입점
- `index.js` (실행 엔트리)
- 실제 로직: `../src/modules/monitor/collector.js`

## 실행
```bash
npm run collector:start
```
