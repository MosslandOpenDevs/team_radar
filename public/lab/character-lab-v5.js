const sheets = Array.from({ length: 20 }, (_, i) => `Premade_Character_48x48_${String(i + 1).padStart(2, '0')}`);

const TILE_W = 48;
const TILE_H = 96;
const SCALE = 2;
const FRAMES_PER_DIR = 6;
const COL_GROUP = {
  right: 0,
  up: 6,
  left: 12,
  down: 18,
};
const ROW_GROUP = {
  idle: 1,
  walk: 2,
};

const grid = document.getElementById('grid');
const modeEl = document.getElementById('mode');
const dirEl = document.getElementById('dir');
const fpsEl = document.getElementById('fps');
const fpsValue = document.getElementById('fpsValue');

const cards = [];

function build() {
  grid.innerHTML = '';
  sheets.forEach((name, i) => {
    const card = document.createElement('article');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'name';
    title.textContent = `${name} (sliced_v5 48x96)`;

    const preview = document.createElement('div');
    preview.className = 'preview';

    const sprite = document.createElement('img');
    sprite.className = 'sprite';
    sprite.style.width = `${TILE_W * SCALE}px`;
    sprite.style.height = `${TILE_H * SCALE}px`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'idle/walk 4방향 6프레임';

    preview.appendChild(sprite);
    card.appendChild(title);
    card.appendChild(preview);
    card.appendChild(meta);
    grid.appendChild(card);

    cards.push({ sprite, frame: i % FRAMES_PER_DIR, name });
  });
}

let lastTs = 0;
function loop(ts) {
  const fps = Number(fpsEl.value);
  const interval = 1000 / fps;

  if (!lastTs || ts - lastTs >= interval) {
    const mode = modeEl.value;
    const dir = dirEl.value;

    cards.forEach((c) => {
      c.frame = (c.frame + 1) % FRAMES_PER_DIR;
      const frame = c.frame + 1;
      c.sprite.src = `../assets/characters/sliced_v5/${c.name}/${mode}_${dir}_f${frame}.png`;
    });

    lastTs = ts;
  }

  requestAnimationFrame(loop);
}

fpsEl.addEventListener('input', () => {
  fpsValue.textContent = `${fpsEl.value} fps`;
});

build();
fpsValue.textContent = `${fpsEl.value} fps`;
requestAnimationFrame(loop);
