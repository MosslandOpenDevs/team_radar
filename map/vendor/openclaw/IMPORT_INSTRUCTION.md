# 다른 프로젝트로 임포트 지시문 (OpenClaw용)

아래 지시문을 다른 프로젝트의 OpenClaw에게 그대로 전달하면 됩니다.

---

## ✅ 그대로 복붙할 지시문

```text
아래 파일/폴더를 현재 프로젝트로 이식해줘.
원본 기준 경로는 /home/teny/.openclaw/workspace/teamradar-map/portable 이다.

복사 대상:
1) oc-character-playground.css
2) oc-character-playground.js
3) /home/teny/.openclaw/workspace/teamradar-map/assets/characters/sliced_v5 폴더 전체

적용 규칙:
- CSS/JS는 프로젝트에서 접근 가능한 public 정적 경로로 배치
  예) public/vendor/openclaw/oc-character-playground.css
      public/vendor/openclaw/oc-character-playground.js
- sliced_v5는 다음 경로로 배치
  예) public/assets/characters/sliced_v5
- 플레이그라운드를 붙일 페이지에 아래를 추가

<link rel="stylesheet" href="/vendor/openclaw/oc-character-playground.css" />
<div id="playground" style="width:100%;height:520px"></div>
<script src="/vendor/openclaw/oc-character-playground.js"></script>
<script>
  OpenClawPlayground.create(document.getElementById('playground'), {
    spriteBasePath: '/assets/characters/sliced_v5',
    actorCount: 24
  });
</script>

검증:
1) 이미지 404 없는지
2) 캐릭터가 랜덤 이동/idle 전환되는지
3) 이름 태그, 초록 출근점, 말풍선(5초 노출/4~8초 쿨다운) 동작 확인

작업이 끝나면 변경 파일 목록과 접속 URL을 보고해줘.
```

---

## 빠른 설명

- `oc-character-playground.js`는 전역 `OpenClawPlayground.create(container, options)` 제공
- 외부 CSS 충돌을 줄이기 위해 `ocpg-*` 네임스페이스 클래스 사용
- 기본 스프라이트 경로는 `./assets/characters/sliced_v5`라서,
  타 프로젝트에서는 `spriteBasePath`를 명시해주는 것이 안전
