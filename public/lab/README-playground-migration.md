# Character Playground Migration Guide

이 문서는 **다른 프로젝트의 OpenClaw 에이전트가 그대로 가져가서 적용**할 수 있도록,
현재 구현된 캐릭터 플레이그라운드의 파일/규칙/검증 절차를 정리한 문서입니다.

---

## 0) 권장: portable 버전 사용

다른 프로젝트 이식은 `portable/` 버전 사용을 권장합니다.

- `portable/oc-character-playground.css`
- `portable/oc-character-playground.js`
- `portable/IMPORT_INSTRUCTION.md` (OpenClaw 지시문 템플릿)

그리고 스프라이트는 동일하게 `assets/characters/sliced_v5`를 사용합니다.

---

## 1) 가져와야 할 파일 (필수)

아래 4개를 그대로 복사하세요.

1. `character-playground.html`
2. `character-playground.css`
3. `character-playground.js`
4. `assets/characters/sliced_v5/` (폴더 전체)

원본 기준 경로:

- `/home/teny/.openclaw/workspace/teamradar-map/character-playground.html`
- `/home/teny/.openclaw/workspace/teamradar-map/character-playground.css`
- `/home/teny/.openclaw/workspace/teamradar-map/character-playground.js`
- `/home/teny/.openclaw/workspace/teamradar-map/public/assets/characters/sliced_v5/`

---

## 2) 타 프로젝트에서의 권장 배치

대상 프로젝트 루트가 `<project-root>`라고 할 때:

- `<project-root>/character-playground.html`
- `<project-root>/character-playground.css`
- `<project-root>/character-playground.js`
- `<project-root>/assets/characters/sliced_v5/...`

> `character-playground.js`는 기본적으로 아래 경로를 사용합니다.
>
> `../assets/characters/sliced_v5/${sheet}/${animState}_${facing}_f${frame}.png`

즉, `assets/characters/sliced_v5` 상대경로를 유지하는 게 가장 안전합니다.

---

## 3) 스프라이트 규격/규칙 (중요)

`sliced_v5`는 아래 기준으로 생성된 리소스입니다.

- 프레임 크기: `48x96`
- 상태: `idle`, `walk`
- 방향: `right`, `up`, `left`, `down`
- 방향당 프레임 수: `6`
- 파일명 패턴: `{state}_{dir}_f{1..6}.png`
  - 예: `walk_left_f3.png`

원본 슬라이싱 기준(참고):
- idle 시작 y: `96`
- walk 시작 y: `192`

---

## 4) 현재 플레이그라운드 기능 요약

- 검은 배경 위 캐릭터 다수 랜덤 이동
- 이동 방향에 맞춰 walk 애니메이션 재생
- 도착 시 idle로 전환 후 잠깐 정지
- 캐릭터 이름 표시
- 이름 왼쪽 초록 점으로 출근 상태 표현
  - 점 있음: 출근
  - 점 없음: 미출근
- 상태 랜덤 변경
- 머리 위 말풍선 랜덤 대사
  - 5초 표시
  - 4~8초 랜덤 쿨다운

---

## 5) 커스터마이징 포인트 (`character-playground.js`)

### 캐릭터 수
```js
createActors(24)
```

### 이동속도 (현재 느리게/귀엽게)
```js
speed: rand(3.2, 7.2)
```

### idle 체류시간
```js
a.stateUntil = now + rand(1200, 3200)
```

### 말풍선 문구
```js
const LINES = [ ... ]
```

### 출근 상태 변경 주기
```js
setInterval(..., 4500)
```

---

## 6) 빠른 검증 체크리스트

1. 페이지 열기: `character-playground.html`
2. 캐릭터 이미지가 깨지지 않는지 확인 (404 없음)
3. 이동 방향과 애니메이션 방향 일치 여부 확인
4. 멈출 때 idle이 보이는지 확인
5. 이름 태그/초록 점/말풍선 표시 확인

### 이미지가 깨질 때 1순위 확인
- `sheet` 값 누락 여부 (`undefined` 경로)
- `assets/characters/sliced_v5` 경로가 실제로 존재하는지
- 상대경로 기준이 HTML 위치와 맞는지

---

## 7) OpenClaw 에이전트에게 바로 줄 프롬프트 예시

```text
다음 파일들을 현재 프로젝트에 그대로 이식해줘:
- character-playground.html
- character-playground.css
- character-playground.js
- assets/characters/sliced_v5 폴더 전체

요구사항:
1) 상대경로 ../assets/characters/sliced_v5/... 유지
2) character-playground.html 단독으로 열면 동작해야 함
3) 캐릭터 랜덤 이동, idle/walk 전환, 방향 동기화 유지
4) 이름 태그 + 초록점(출근), 랜덤 말풍선(5초 표시/4~8초 쿨다운) 유지
5) 적용 후 실행 URL 또는 실행 방법 안내
```

---

## 8) 참고

이 문서는 마이그레이션용입니다.
기능 원본은 `character-playground.*` 파일이므로, 수정은 해당 소스에서 진행하세요.
