/**
 * ambient-bg.js — 공유 배경 애니메이션 (맵/대시보드 공통)
 *
 * 수정 포인트 (window.AMBIENT_BG 객체로 덮어쓰기):
 *   BG_COLOR      — 배경 기본색         (기본: '#05070a')
 *   SCANLINE      — CRT 스캔라인 ON/OFF (기본: true)
 *   STAR_COUNT    — 별 총 개수          (기본: 180)
 *   GRID_SIZE     — 그리드 셀 크기 px   (기본: 48)
 *   PULSE_ENABLED — 레이더 핑 ON/OFF    (기본: true)
 */
(function () {
  'use strict';

  window.AMBIENT_BG = Object.assign({
    BG_COLOR      : '#05070a',
    SCANLINE      : true,
    STAR_COUNT    : 180,
    GRID_SIZE     : 48,
    PULSE_ENABLED : true,
  }, window.AMBIENT_BG || {});

  // ── DOM 생성 ──────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'ambient-bg-canvas';
  Object.assign(canvas.style, {
    position      : 'fixed',
    top           : '0', left: '0',
    width         : '100%', height: '100%',
    zIndex        : '0',
    pointerEvents : 'none',
    imageRendering: 'pixelated',
  });

  // CRT 수평 스캔라인 오버레이
  const overlay = document.createElement('div');
  overlay.id = 'ambient-bg-overlay';
  Object.assign(overlay.style, {
    position      : 'fixed',
    top           : '0', left: '0',
    width         : '100%', height: '100%',
    background    : 'linear-gradient(transparent 50%, rgba(0,0,0,0.08) 50%)',
    backgroundSize: '100% 3px',
    pointerEvents : 'none',
    zIndex        : '1',
  });

  function mount() {
    document.body.insertBefore(overlay, document.body.firstChild);
    document.body.insertBefore(canvas, document.body.firstChild);
    if (!window.AMBIENT_BG.SCANLINE) overlay.style.display = 'none';
    init();
  }

  // ── 상태 ─────────────────────────────────────────────────────
  const ctx  = canvas.getContext('2d');
  let W = 0, H = 0, frame = 0;

  // ── 별 (3개 레이어) ───────────────────────────────────────────
  // layer 0: 작은 배경별 — 미세하게 반짝임
  // layer 1: 중간별 — 천천히 드리프트
  // layer 2: 밝은 전경별 — 뚜렷하게 빛남
  const LAYERS = [
    { ratio: 0.55, size: 1, drift: 0.006, lo: 0.18, hi: 0.45, twinkle: 0.010 },
    { ratio: 0.32, size: 1, drift: 0.022, lo: 0.35, hi: 0.70, twinkle: 0.016 },
    { ratio: 0.13, size: 2, drift: 0.048, lo: 0.55, hi: 0.95, twinkle: 0.022 },
  ];
  const stars = [];

  class Star {
    constructor(layerIdx, scatter) {
      this.l = layerIdx;
      this._init(scatter);
    }
    _init(scatter) {
      const L = LAYERS[this.l];
      this.x     = Math.random() * W;
      this.y     = scatter ? Math.random() * H : H + 4;
      this.speed = L.drift * (0.6 + Math.random() * 0.8);
      this.base  = L.lo + Math.random() * (L.hi - L.lo);
      this.op    = this.base;
      this.phase = Math.random() * Math.PI * 2;
      this.tspd  = L.twinkle * (0.7 + Math.random() * 0.6);
      this.size  = L.size;
    }
    tick() {
      this.y    -= this.speed;
      this.phase += this.tspd;
      // 반짝임: 최소 opacity 보장 (0 아래로 안 내려감)
      this.op = Math.max(0, this.base * (0.3 + 0.7 * Math.sin(this.phase)));
      if (this.y < -4) this._init(false);
    }
    draw() {
      if (this.op < 0.02) return;
      const px = (this.x | 0) & ~1;
      const py = (this.y | 0) & ~1;
      ctx.fillStyle = `rgba(0,220,255,${this.op.toFixed(2)})`;
      ctx.fillRect(px, py, this.size, this.size);
    }
  }

  // ── 그리드 노드 (교차점 도트 + 은은한 선) ────────────────────
  let nodes = [];

  function buildNodes() {
    nodes = [];
    const G = window.AMBIENT_BG.GRID_SIZE;
    for (let y = 0; y <= H + G; y += G) {
      for (let x = 0; x <= W + G; x += G) {
        nodes.push({
          x, y,
          phase: Math.random() * Math.PI * 2,
          spd  : 0.005 + Math.random() * 0.007,
        });
      }
    }
  }

  function drawGrid() {
    const G = window.AMBIENT_BG.GRID_SIZE;

    // 격자선 — 은은하게
    ctx.strokeStyle = 'rgba(0,190,230,0.05)';
    ctx.lineWidth   = 1;
    for (let x = 0; x <= W; x += G) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += G) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 교차점 도트 — 뚜렷하게 반짝임
    for (const n of nodes) {
      n.phase += n.spd;
      const op = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(n.phase));
      ctx.fillStyle = `rgba(0,230,255,${op.toFixed(3)})`;
      ctx.fillRect(n.x - 1, n.y - 1, 2, 2);
    }
  }

  // ── 수평 스캔 광선 ────────────────────────────────────────────
  let scanY = 0;

  function drawScan() {
    scanY = (scanY + 0.3) % H;
    const g = ctx.createLinearGradient(0, scanY - 60, 0, scanY + 60);
    g.addColorStop(0,    'rgba(0,242,255,0)');
    g.addColorStop(0.3,  'rgba(0,242,255,0.02)');
    g.addColorStop(0.5,  'rgba(0,242,255,0.06)');
    g.addColorStop(0.7,  'rgba(0,242,255,0.02)');
    g.addColorStop(1,    'rgba(0,242,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, scanY - 60, W, 120);
  }

  // ── 레이더 핑 (펄스 링) ───────────────────────────────────────
  let pingTimer = 0;
  const PING_INTERVAL = 160;
  const pings = [];

  function updatePings() {
    if (!window.AMBIENT_BG.PULSE_ENABLED) return;
    pingTimer++;
    if (pingTimer >= PING_INTERVAL && nodes.length) {
      pingTimer = 0;
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      pings.push({ x: n.x, y: n.y, r: 0, maxR: 32 + Math.random() * 24, life: 1.0 });
    }
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      p.r    += 0.8;
      p.life -= 0.020;
      if (p.life <= 0 || p.r > p.maxR) { pings.splice(i, 1); continue; }
      const op = p.life * 0.45;
      ctx.strokeStyle = `rgba(0,242,255,${op.toFixed(3)})`;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── 비네트 ────────────────────────────────────────────────────
  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, W * 0.8);
    g.addColorStop(0, 'rgba(0,8,20,0)');
    g.addColorStop(1, 'rgba(0,3,8,0.75)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── 메인 루프 ─────────────────────────────────────────────────
  function tick() {
    frame++;

    ctx.fillStyle = window.AMBIENT_BG.BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    drawGrid();
    for (const s of stars) { s.tick(); s.draw(); }
    drawScan();
    updatePings();
    drawVignette();

    requestAnimationFrame(tick);
  }

  // ── 초기화 ────────────────────────────────────────────────────
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
    buildNodes();
  }

  function init() {
    resize();
    window.addEventListener('resize', resize);
    const total = window.AMBIENT_BG.STAR_COUNT;
    for (let li = 0; li < LAYERS.length; li++) {
      const count = Math.round(total * LAYERS[li].ratio);
      for (let i = 0; i < count; i++) stars.push(new Star(li, true));
    }
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
