const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'team-status-db.json');
const COLLISION_OVERRIDES_FILE = path.join(DATA_DIR, 'collision-overrides.json');
const COLLISION_MASK_FILE = path.join(ROOT_DIR, 'public', 'assets', 'custom-map', 'collision_mask.png');

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  DB_FILE,
  COLLISION_OVERRIDES_FILE,
  COLLISION_MASK_FILE,
};
