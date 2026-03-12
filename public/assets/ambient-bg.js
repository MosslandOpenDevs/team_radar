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
    position: 'fixed', top: '0', left: '0',
    width: '100%', height: '100%',
    zIndex: '0', pointerEvents: 'none',
    imageRendering: 'pixelated',
  });

  const overlay = document.createElement('div');
  overlay.id = 'ambient-bg-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0',
    width: '100%', height: '100%',
    background: 'linear-gradient(transparent 50%, rgba(0,0,0,0.08) 50%)',
    backgroundSize: '100% 3px',
    pointerEvents: 'none', zIndex: '1',
  });

  function mount() {
    document.body.insertBefore(overlay, document.body.firstChild);
    document.body.insertBefore(canvas, document.body.firstChild);
    if (!window.AMBIENT_BG.SCANLINE) overlay.style.display = 'none';
    init();
  }

  // ── 렌더 상태 ─────────────────────────────────────────────────
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, frame = 0;
  let paused = false; // visibilitychange 로 제어

  // ── opacity 룩업테이블 (런타임 문자열 할당 제거) ──────────────
  // 별: 0.00~1.00 → 101개 (2dp)
  const RGBA_STAR = Array.from({ length: 101 }, (_, i) =>
    `rgba(0,220,255,${(i / 100).toFixed(2)})`);
  // 그리드 노드: 0.000~0.400 → 401개 (3dp)
  const RGBA_NODE = Array.from({ length: 401 }, (_, i) =>
    `rgba(0,230,255,${(i / 1000).toFixed(3)})`);
  // 핑 링: 0.00~0.50 → 51개 (2dp)
  const RGBA_PING = Array.from({ length: 51 }, (_, i) =>
    `rgba(0,242,255,${(i / 100).toFixed(2)})`);

  // ── 별 (3레이어) ──────────────────────────────────────────────
  const LAYERS = [
    { ratio: 0.55, size: 1, drift: 0.006, lo: 0.18, hi: 0.45, twinkle: 0.010 },
    { ratio: 0.32, size: 1, drift: 0.022, lo: 0.35, hi: 0.70, twinkle: 0.016 },
    { ratio: 0.13, size: 2, drift: 0.048, lo: 0.55, hi: 0.95, twinkle: 0.022 },
  ];
  const stars = [];

  class Star {
    constructor(li, scatter) { this.l = li; this._init(scatter); }
    _init(scatter) {
      const L = LAYERS[this.l];
      this.x    = Math.random() * W;
      this.y    = scatter ? Math.random() * H : H + 4;
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
      this.op    = Math.max(0, this.base * (0.3 + 0.7 * Math.sin(this.phase)));
      if (this.y < -4) this._init(false);
    }
    draw() {
      if (this.op < 0.02) return;
      // 룩업테이블로 문자열 할당 제거
      ctx.fillStyle = RGBA_STAR[Math.round(this.op * 100)];
      ctx.fillRect((this.x | 0) & ~1, (this.y | 0) & ~1, this.size, this.size);
    }
  }

  // ── 그리드 노드 ───────────────────────────────────────────────
  let nodes = [];

  function buildNodes() {
    nodes = [];
    const G = window.AMBIENT_BG.GRID_SIZE;
    for (let y = 0; y <= H + G; y += G)
      for (let x = 0; x <= W + G; x += G)
        nodes.push({ x, y, phase: Math.random() * Math.PI * 2, spd: 0.005 + Math.random() * 0.007 });
  }

  function drawGrid() {
    const G = window.AMBIENT_BG.GRID_SIZE;

    // 격자선 — 배치(batch): 수직 한 번, 수평 한 번으로 draw call 최소화
    ctx.strokeStyle = 'rgba(0,190,230,0.05)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += G) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    ctx.stroke();
    ctx.beginPath();
    for (let y = 0; y <= H; y += G) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // 교차점 도트 — 룩업테이블 사용
    for (const n of nodes) {
      n.phase += n.spd;
      const op = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(n.phase)); // 0.12~0.30
      ctx.fillStyle = RGBA_NODE[Math.round(op * 1000)];
      ctx.fillRect(n.x - 1, n.y - 1, 2, 2);
    }
  }

  // ── 스캔라인: 오프스크린 캔버스로 그라디언트 1회 생성 ──────────
  let scanCanvas = null, scanCtx = null, scanY = 0;
  const SCAN_H = 120;

  function buildScanCanvas() {
    scanCanvas     = document.createElement('canvas');
    scanCanvas.width  = 4;    // 최소 너비 (수평 방향 무관)
    scanCanvas.height = SCAN_H;
    scanCtx = scanCanvas.getContext('2d');
    const g = scanCtx.createLinearGradient(0, 0, 0, SCAN_H);
    g.addColorStop(0,    'rgba(0,242,255,0)');
    g.addColorStop(0.30, 'rgba(0,242,255,0.02)');
    g.addColorStop(0.50, 'rgba(0,242,255,0.06)');
    g.addColorStop(0.70, 'rgba(0,242,255,0.02)');
    g.addColorStop(1,    'rgba(0,242,255,0)');
    scanCtx.fillStyle = g;
    scanCtx.fillRect(0, 0, 4, SCAN_H);
  }

  function drawScan() {
    scanY = (scanY + 0.3) % H;
    // 오프스크린 캔버스를 blit — 그라디언트 재생성 없음
    ctx.drawImage(scanCanvas, 0, 0, 4, SCAN_H, 0, scanY - SCAN_H / 2, W, SCAN_H);
  }

  // ── 비네트 — resize 시 1회 생성 ───────────────────────────────
  let vignetteGrad = null;

  function buildVignette() {
    vignetteGrad = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, W * 0.8);
    vignetteGrad.addColorStop(0, 'rgba(0,8,20,0)');
    vignetteGrad.addColorStop(1, 'rgba(0,3,8,0.75)');
  }

  function drawVignette() {
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(0, 0, W, H);
  }

  // ── 레이더 핑 ─────────────────────────────────────────────────
  let pingTimer = 0;
  const pings = [];

  function updatePings() {
    if (!window.AMBIENT_BG.PULSE_ENABLED) return;
    if (++pingTimer >= 160 && nodes.length) {
      pingTimer = 0;
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      pings.push({ x: n.x, y: n.y, r: 0, maxR: 32 + Math.random() * 24, life: 1.0 });
    }
    ctx.lineWidth = 1;
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      p.r += 0.8; p.life -= 0.020;
      if (p.life <= 0 || p.r > p.maxR) { pings.splice(i, 1); continue; }
      ctx.strokeStyle = RGBA_PING[Math.round(p.life * 0.45 * 100)];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── 메인 루프 ─────────────────────────────────────────────────
  function tick() {
    requestAnimationFrame(tick);
    if (paused) return; // 탭 숨김 시 렌더링 스킵

    frame++;
    ctx.fillStyle = window.AMBIENT_BG.BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    drawGrid();
    for (const s of stars) { s.tick(); s.draw(); }
    drawScan();
    updatePings();
    drawVignette();
  }

  // ── 초기화 / 리사이즈 ─────────────────────────────────────────
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
    buildNodes();
    buildVignette(); // 뷰포트 크기 변경 시 재생성
  }

  function init() {
    resize();
    buildScanCanvas(); // 오프스크린 스캔 캔버스 1회 생성

    window.addEventListener('resize', resize);

    // 탭 숨김/복귀 시 애니메이션 일시정지
    document.addEventListener('visibilitychange', () => {
      paused = document.hidden;
    });

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
