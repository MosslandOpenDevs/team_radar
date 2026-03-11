(function (global) {
  const DIRS = ['right', 'up', 'left', 'down'];
  const STATUS = { OFFICE: 'office', AWAY: 'away' };
  const DEFAULT_LINES = [
    '어? 거기 누구야?', '커피 한 잔 할래?', '오늘 집중 잘 되네', '잠깐만, 메모 좀…',
    '회의 곧 시작이지?', '점심 뭐 먹지?', '오 이거 좋은데?', '지금 바로 할게!'
  ];
  const DEFAULT_NAMES = [
    'Teny','Mina','Jun','Ara','Leo','Soo','Hana','Jisoo','Evan','Noah','Yuna','Rin',
    'Dami','Kai','Nari','Yujin','Haru','Momo','Ian','Zoe','Lia','Theo','Sena','Jin'
  ];

  function rand(min, max) { return min + Math.random() * (max - min); }

  function createCharacterPlayground(container, userOptions = {}) {
    if (!container) throw new Error('container is required');

    const opt = {
      spriteBasePath: './assets/characters/sliced_v5',
      frameW: 48,
      frameH: 96,
      frames: 6,
      actorCount: 24,
      speedMin: 3.2,
      speedMax: 7.2,
      idleMinMs: 1200,
      idleMaxMs: 3200,
      bubbleShowMs: 5000,
      bubbleGapMinMs: 4000,
      bubbleGapMaxMs: 8000,
      statusTickMs: 4500,
      animTickMs: 140,
      names: DEFAULT_NAMES,
      lines: DEFAULT_LINES,
      sheets: Array.from({ length: 20 }, (_, i) => `Premade_Character_48x48_${String(i + 1).padStart(2, '0')}`),
      ...userOptions,
    };

    container.classList.add('ocpg-stage');
    container.style.setProperty('--ocpg-frame-w', `${opt.frameW}px`);
    container.style.setProperty('--ocpg-frame-h', `${opt.frameH}px`);

    const actors = [];
    let rafId = null;
    let statusTimer = null;
    let lastTs = 0;
    let lastAnim = 0;

    function pickTarget() {
      return { x: rand(4, 96), y: rand(20, 98) };
    }

    function frameSrc(a) {
      return `${opt.spriteBasePath}/${a.sheet}/${a.animState}_${a.facing}_f${a.frame}.png`;
    }

    function applyStatusClass(a) {
      a.el.classList.toggle('is-away', a.status === STATUS.AWAY);
    }

    function randomLine() {
      return opt.lines[Math.floor(Math.random() * opt.lines.length)];
    }

    function updateBubble(a, now) {
      if (a.bubbleVisible) {
        if (now >= a.bubbleUntil) {
          a.bubbleVisible = false;
          a.bubble.classList.add('ocpg-hidden');
          a.bubbleCooldownUntil = now + rand(opt.bubbleGapMinMs, opt.bubbleGapMaxMs);
        }
        return;
      }
      if (now >= a.bubbleCooldownUntil && now >= a.bubbleUntil) {
        a.bubbleVisible = true;
        a.bubble.textContent = `${a.name}: ${randomLine()}`;
        a.bubble.classList.remove('ocpg-hidden');
        a.bubbleUntil = now + opt.bubbleShowMs;
      }
    }

    function updateActor(a, dt, now) {
      if (a.animState === 'idle' && now >= a.stateUntil) {
        const t = pickTarget();
        a.targetX = t.x; a.targetY = t.y;
        a.animState = 'walk';
        a.frame = 1;
      }

      if (a.animState === 'walk') {
        const dx = a.targetX - a.x;
        const dy = a.targetY - a.y;
        const dist = Math.hypot(dx, dy);

        if (dist < 0.8) {
          a.animState = 'idle';
          a.stateUntil = now + rand(opt.idleMinMs, opt.idleMaxMs);
          a.frame = 1;
          a.img.src = frameSrc(a);
        } else {
          const step = (a.speed * dt) / 1000;
          a.x += (dx / dist) * step;
          a.y += (dy / dist) * step;
          a.facing = Math.abs(dx) > Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
        }
      }

      a.el.style.left = `${a.x}%`;
      a.el.style.top = `${a.y}%`;
    }

    function tick(ts) {
      if (!lastTs) lastTs = ts;
      const dt = ts - lastTs;
      lastTs = ts;

      for (const a of actors) {
        updateActor(a, dt, ts);
        updateBubble(a, ts);
      }

      if (!lastAnim || ts - lastAnim >= opt.animTickMs) {
        for (const a of actors) {
          a.frame = a.animState === 'walk' ? (a.frame % opt.frames) + 1 : 1;
          a.img.src = frameSrc(a);
        }
        lastAnim = ts;
      }

      rafId = requestAnimationFrame(tick);
    }

    function mountActors() {
      container.innerHTML = '';
      for (let i = 0; i < opt.actorCount; i++) {
        const el = document.createElement('div');
        el.className = 'ocpg-actor';

        const img = document.createElement('img');
        img.className = 'ocpg-sprite';

        const bubble = document.createElement('div');
        bubble.className = 'ocpg-bubble ocpg-hidden';

        const name = document.createElement('div');
        name.className = 'ocpg-name';
        name.textContent = opt.names[i % opt.names.length];

        el.appendChild(img);
        el.appendChild(bubble);
        el.appendChild(name);
        container.appendChild(el);

        const start = pickTarget();
        const target = pickTarget();
        const actor = {
          el, img, bubble,
          name: opt.names[i % opt.names.length],
          sheet: opt.sheets[i % opt.sheets.length],
          x: start.x, y: start.y,
          targetX: target.x, targetY: target.y,
          speed: rand(opt.speedMin, opt.speedMax),
          facing: DIRS[Math.floor(Math.random() * DIRS.length)],
          frame: (i % opt.frames) + 1,
          animState: 'walk',
          stateUntil: performance.now() + rand(900, 2500),
          status: Math.random() < 0.72 ? STATUS.OFFICE : STATUS.AWAY,
          bubbleVisible: false,
          bubbleUntil: performance.now() + rand(1500, 7000),
          bubbleCooldownUntil: 0,
        };

        img.src = frameSrc(actor);
        applyStatusClass(actor);
        actors.push(actor);
      }
    }

    function start() {
      if (rafId) return;
      rafId = requestAnimationFrame(tick);
      statusTimer = setInterval(() => {
        const changes = Math.max(1, Math.floor(Math.random() * 4));
        for (let i = 0; i < changes; i++) {
          const a = actors[Math.floor(Math.random() * actors.length)];
          if (!a) continue;
          a.status = Math.random() < 0.72 ? STATUS.OFFICE : STATUS.AWAY;
          applyStatusClass(a);
        }
      }, opt.statusTickMs);
    }

    function destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      if (statusTimer) clearInterval(statusTimer);
      rafId = null;
      statusTimer = null;
      actors.length = 0;
      container.innerHTML = '';
    }

    mountActors();
    start();

    return { start, destroy, options: opt };
  }

  global.OpenClawPlayground = { create: createCharacterPlayground };
})(window);
