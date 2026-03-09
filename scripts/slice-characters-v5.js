const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const TILE_W = 48;
const TILE_H = 96;
const FRAMES = 6;
const INPUT_DIR = '/home/teny/.openclaw/workspace/teamradar-map/public/assets/characters';
const OUT = '/home/teny/.openclaw/workspace/teamradar-map/public/assets/characters/sliced_v5';

// 요청 기준: 상단에서 2번째 라인 idle, 3번째 라인 walk
const Y_OFFSETS = {
  idle: 96,
  walk: 192,
};

const DIRS = ['right', 'up', 'left', 'down'];

fs.mkdirSync(OUT, { recursive: true });

const files = fs
  .readdirSync(INPUT_DIR)
  .filter((f) => /^Premade_Character_48x48_\d+\.png$/i.test(f))
  .sort();

const manifest = [];

function crop(png, x0, y0) {
  const tile = new PNG({ width: TILE_W, height: TILE_H });
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      const si = (sy * png.width + sx) * 4;
      const di = (y * TILE_W + x) * 4;
      tile.data[di] = png.data[si];
      tile.data[di + 1] = png.data[si + 1];
      tile.data[di + 2] = png.data[si + 2];
      tile.data[di + 3] = png.data[si + 3];
    }
  }
  return tile;
}

for (const file of files) {
  const src = path.join(INPUT_DIR, file);
  const png = PNG.sync.read(fs.readFileSync(src));
  const outDir = path.join(OUT, path.parse(file).name);
  fs.mkdirSync(outDir, { recursive: true });

  for (const [state, y] of Object.entries(Y_OFFSETS)) {
    for (let d = 0; d < DIRS.length; d++) {
      const dir = DIRS[d];
      const startCol = d * FRAMES;
      for (let f = 0; f < FRAMES; f++) {
        const col = startCol + f;
        const x = col * TILE_W;
        const tile = crop(png, x, y);
        const outName = `${state}_${dir}_f${f + 1}.png`;
        const outPath = path.join(outDir, outName);
        fs.writeFileSync(outPath, PNG.sync.write(tile));
        manifest.push({
          sheet: file,
          state,
          dir,
          frame: f + 1,
          x,
          y,
          w: TILE_W,
          h: TILE_H,
          out: path.relative(OUT, outPath),
        });
      }
    }
  }
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`done: sheets=${files.length}, frames=${manifest.length}, tile=${TILE_W}x${TILE_H}, out=${OUT}`);
