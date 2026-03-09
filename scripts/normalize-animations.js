const fs = require('fs');
const path = require('path');

const ROOT = '/home/teny/.openclaw/workspace/teamradar-map/public/assets/characters/sliced';
const OUT = path.join(ROOT, 'normalized');
const dirs = ['right', 'up', 'left', 'down'];
const states = ['idle', 'walk'];

fs.mkdirSync(OUT, { recursive: true });

const chars = fs
  .readdirSync(ROOT)
  .filter((d) => d.startsWith('Premade_Character_48x48_') && fs.statSync(path.join(ROOT, d)).isDirectory())
  .sort();

let filled = 0;
let copied = 0;

function exists(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 0;
}

for (const ch of chars) {
  const srcDir = path.join(ROOT, ch);
  const outDir = path.join(OUT, ch);
  fs.mkdirSync(outDir, { recursive: true });

  for (const state of states) {
    for (const dir of dirs) {
      for (let frame = 1; frame <= 5; frame++) {
        const target = `${state}_${dir}_f${frame}.png`;
        const srcExact = path.join(srcDir, target);

        let chosen = null;
        if (exists(srcExact)) {
          chosen = srcExact;
          copied++;
        } else {
          // Fallback priority
          const candidates = [
            path.join(srcDir, `${state}_${dir}_f1.png`),
            path.join(srcDir, `walk_${dir}_f${frame}.png`),
            path.join(srcDir, `walk_${dir}_f3.png`),
            path.join(srcDir, `idle_right_f1.png`),
            path.join(srcDir, `walk_right_f1.png`),
          ];

          for (const c of candidates) {
            if (exists(c)) {
              chosen = c;
              filled++;
              break;
            }
          }
        }

        if (!chosen) continue;
        fs.copyFileSync(chosen, path.join(outDir, target));
      }
    }
  }
}

const meta = {
  generatedAt: new Date().toISOString(),
  characters: chars.length,
  copiedExact: copied,
  filledFallback: filled,
  totalExpected: chars.length * states.length * dirs.length * 5,
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(meta);
