# Discord Monitor (근태 + 업무 채널 집계)

이 스크립트는 `.env`에 지정한 채널만 모니터링해서,
- 근태 채널: 출근/퇴근/휴가/자리비움 등 상태 추적
- 업무공유 채널: 진행중/완료/이슈 등 상태 추적

을 수행하고, `!teamstatus` 명령으로 현재 스냅샷을 보여줍니다.

## 1) 설치

```bash
cd /home/teny/.openclaw/workspace/teamradar-map
npm install
```

## 2) 환경변수 설정

```bash
cp .env.example .env
# .env 열어서 토큰/채널 ID 입력
```

### 필요한 값
- `DISCORD_BOT_TOKEN`: 봇 토큰
- `ATTENDANCE_CHANNEL_IDS`: 근태 채널 ID(쉼표 구분)
- `WORK_CHANNEL_IDS`: 업무공유 채널 ID(쉼표 구분)
- `COMMAND_CHANNEL_IDS`(선택): `!teamstatus` 명령 허용 채널

## 3) 실행

터미널 1 (디스코드 수집기):

```bash
npm run monitor:discord
```

터미널 2 (대시보드):

```bash
npm run dashboard
```

브라우저에서:

```text
http://localhost:3100/dashboard
```

(포트 변경 시 `.env`의 `DASHBOARD_PORT` 사용)

## 4) 사용
- 모니터링 채널에 멤버가 메시지를 남기면 상태가 업데이트됩니다.
- 현재 상태 확인: `!teamstatus`
- 최근 로그 확인: `!teamlogs`
- 근태 이름 매핑 등록: `!mapname @유저 근태이름`
- 근태 이름 매핑 삭제: `!unmapname @유저`
- 근태 이름 매핑 조회: `!namemap`
- 대시보드에서 `근태이름 -> 디스코드 멤버` 매핑을 입력하고 `매핑 Apply` 버튼으로 저장 가능
- 매핑 UI는 근태이름(최근 메시지 추출) 드롭다운 + 디스코드 멤버 드롭다운으로 구성
- 멤버 목록 로딩을 위해 `.env`에 `DISCORD_GUILD_ID` 설정 필요
- 근태이름 후보 기간은 `.env`의 `ATTENDANCE_NAME_LOOKBACK_DAYS`(기본 5일)

## DB 구조 (간단 확장형)
저장 파일: `data/team-status-db.json`

## API (대시보드/외부연동용)
- `GET /api/team/status` : 유저별 최신 상태 + 요약
- `GET /api/team/logs?limit=20` : 최근 이벤트 로그

## 재시작 동기화 (근태)
봇이 재시작될 때 근태 채널에서 최근 KST 기준 데이터를 다시 읽어 동기화할 수 있습니다.

- `STARTUP_ATTENDANCE_BACKFILL=true`
- `ATTENDANCE_BACKFILL_DAYS_KST=1`  (기본: 최근 1일)

즉, 프로세스가 죽었다 살아나도 최근 하루 근태 상태를 DB 기준으로 빠르게 복원합니다.

- `users[]`
  - 사용자별 최신 근태 상태
  - 사용자별 최신 업무 상태
  - 사용자별 최근 업무 로그 리스트(`workLogs`)
- `events[]`
  - 근태/업무 이벤트 히스토리 (최대 5000개 유지)

`.env`에서 `MAX_WORK_LOGS_PER_USER`로 사용자별 업무 로그 보관 개수 조절 가능

## 파싱 규칙(초기 버전)
- 근태: `출근`, `퇴근`, `휴가`, `지각`, `외근/자리비움`, `복귀` 키워드 기반
- 업무: `진행`, `완료`, `대기/보류`, `이슈/막힘`, `리뷰` 키워드 기반

원하면 다음 단계로:
1. 채널별 템플릿(예: `출근 09:11`) 강제 파서
2. 상태를 WebSocket/REST API로 노출해서 메타버스 맵 실시간 연동
3. 메시지 수정/삭제 이벤트까지 반영
