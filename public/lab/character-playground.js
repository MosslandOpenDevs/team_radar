const DIRS = ['right', 'up', 'left', 'down'];
const FRAMES = 6;
const SHEETS = Array.from({ length: 20 }, (_, i) => `Premade_Character_48x48_${String(i + 1).padStart(2, '0')}`);

const stage = document.getElementById('stage');
const actors = [];

const NAMES = [
  'Teny', 'Mina', 'Jun', 'Ara', 'Leo', 'Soo', 'Hana', 'Jisoo',
  'Evan', 'Noah', 'Yuna', 'Rin', 'Dami', 'Kai', 'Nari', 'Yujin',
  'Haru', 'Momo', 'Ian', 'Zoe', 'Lia', 'Theo', 'Sena', 'Jin',
];

const STATUS = {
  OFFICE: 'office',
  AWAY: 'away',
};

const LINES = [
  '어? 거기 누구야?',
  '커피 한 잔 할래?',
  '오늘 집중 잘 되네',
  '잠깐만, 메모 좀…',
  '회의 곧 시작이지?',
  '점심 뭐 먹지?',
  '오 이거 좋은데?',
  '지금 바로 할게!',
  '브랜치 정리 완료~',
  '버그 찾았다 👀',
  '와… 또 머지 충돌',
  '오늘 컨디션 굿',
];

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pickTarget(bounds) {
  const marginX = 4;
  const marginY = 8;
  return {
    x: rand(marginX, 100 - marginX),
    y: rand(marginY, 100 - marginY),
  };
}

function frameSrc(a) {
  return `../assets/characters/sliced_v5/${a.sheet}/${a.animState}_${a.facing}_f${a.frame}.png`;
}

function randomLine() {
  return LINES[Math.floor(Math.random() * LINES.length)];
}

function applyStatusClass(a) {
  a.el.classList.toggle('is-away', a.status === STATUS.AWAY);
}

function updateBubble(a, now) {
  // 말풍선 노출 상태
  if (a.bubbleVisible) {
    if (now >= a.bubbleUntil) {
      a.bubbleVisible = false;
      a.bubble.classList.add('hidden');
      a.bubbleCooldownUntil = now + rand(4000, 8000); // 4~8초 휴식
    }
    return;
  }

  // 다음 말풍선 표시 타이밍
  if (now >= a.bubbleCooldownUntil && now >= a.bubbleUntil) {
    a.bubbleVisible = true;
    a.bubble.textContent = `${a.name}: ${randomLine()}`;
    a.bubble.classList.remove('hidden');
    a.bubbleUntil = now + 5000; // 5초 표시
  }
}

function createActors(count = 24) {
  const bounds = stage.getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'actor';

    const img = document.createElement('img');
    const bubble = document.createElement('div');
    bubble.className = 'bubble hidden';
    const nameTag = document.createElement('div');
    nameTag.className = 'name-tag';
    nameTag.textContent = NAMES[i % NAMES.length];

    el.appendChild(img);
    el.appendChild(bubble);
    el.appendChild(nameTag);
    stage.appendChild(el);

    const start = pickTarget(bounds);
    const target = pickTarget(bounds);

    const actor = {
      x: start.x,
      y: start.y,
      targetX: target.x,
      targetY: target.y,
      speed: rand(3.2, 7.2), // % per second scale (slower/cuter)
      name: NAMES[i % NAMES.length],
      status: Math.random() < 0.72 ? STATUS.OFFICE : STATUS.AWAY,
      sheet: SHEETS[i % SHEETS.length],
      facing: DIRS[Math.floor(Math.random() * DIRS.length)],
      frame: (i % FRAMES) + 1,
      animState: 'walk',
      stateUntil: performance.now() + rand(900, 2500),
      bubble,
      bubbleVisible: false,
      bubbleUntil: performance.now() + rand(1500, 7000),
      bubbleCooldownUntil: 0,
      el,
      img,
    };

    img.src = frameSrc(actor);
    applyStatusClass(actor);
    actors.push(actor);
  }
}

function updateActor(a, dt, now) {
  // idle 구간 끝나면 다시 이동 시작
  if (a.animState === 'idle' && now >= a.stateUntil) {
    const t = pickTarget();
    a.targetX = t.x;
    a.targetY = t.y;
    a.animState = 'walk';
    a.frame = 1;
  }

  if (a.animState === 'walk') {
    const dx = a.targetX - a.x;
    const dy = a.targetY - a.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.8) {
      // 도착하면 잠깐 멈춤(idle), 마지막 방향 유지
      a.animState = 'idle';
      a.stateUntil = now + rand(1200, 3200);
      a.frame = 1;
      a.img.src = frameSrc(a);
    } else {
      const step = (a.speed * dt) / 1000;
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;

      if (Math.abs(dx) > Math.abs(dy)) a.facing = dx >= 0 ? 'right' : 'left';
      else a.facing = dy >= 0 ? 'down' : 'up';
    }
  }

  a.el.style.left = `${a.x}%`;
  a.el.style.top = `${a.y}%`;
}

let lastTs = 0;
let lastAnim = 0;
function tick(ts) {
  if (!lastTs) lastTs = ts;
  const dt = ts - lastTs;
  lastTs = ts;

  for (const a of actors) {
    updateActor(a, dt, ts);
    updateBubble(a, ts);
  }

  if (!lastAnim || ts - lastAnim >= 140) {
    for (const a of actors) {
      if (a.animState === 'walk') {
        a.frame = (a.frame % FRAMES) + 1;
      } else {
        // idle은 확실히 보이도록 1프레임 고정
        a.frame = 1;
      }
      a.img.src = frameSrc(a);
    }
    lastAnim = ts;
  }

  requestAnimationFrame(tick);
}

createActors();
requestAnimationFrame(tick);

window.addEventListener('resize', () => {
  // 리사이즈 시에도 퍼센트 좌표 유지되므로 별도 보정 불필요
});

// 출근/미출근 상태를 랜덤 변경 (초록 점 유무로 표현)
setInterval(() => {
  const changes = Math.max(1, Math.floor(Math.random() * 4));
  for (let i = 0; i < changes; i++) {
    const a = actors[Math.floor(Math.random() * actors.length)];
    if (!a) continue;
    a.status = Math.random() < 0.72 ? STATUS.OFFICE : STATUS.AWAY;
    applyStatusClass(a);
  }
}, 4500);


