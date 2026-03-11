#!/usr/bin/env python3
"""
extract_sprites.py — Office Tileset Sprite Extractor

PNG backgrounds are transparent (alpha=0), not white.
Strategy:
  office1/office2 → 8-connectivity label → bounding boxes (merge_dist=0)
  floors          → 64×64 grid cells
  walls           → 8-connectivity label

Usage:  python3 extract_sprites.py
Output: tileset_meta.json (same directory)
"""

from PIL import Image
import numpy as np
from scipy.ndimage import label
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent

# ── Descriptive name hints ordered by (y, x) of bounding box ─────────────────
OFFICE1_NAMES = [
    "desk_small_brown_a", "desk_small_brown_b",
    "desk_long_mixed",
    "desk_with_drawer",
    "desk_row_group",
    "shelf_small_a", "shelf_small_b",
    "large_furniture_section",
]

OFFICE2_NAMES = [
    "chairs_monitors_top",
    "locker_column",
    "vending_machine",
    "pc_towers",
    "board_row",
    "color_dot",
    "wall_items",
    "lower_furniture_section",
]

FLOOR_NAMES = [
    "floor_dark_charcoal",  "floor_light_gray",    "floor_sage_green",
    "floor_steel_blue",     "floor_warm_tan",       "floor_slate_blue",
    "floor_sand_beige",     "floor_seafoam",
    "floor_gray_xpattern",  "floor_teal_xpattern",  "floor_sage_xpattern",
    "floor_blue_xpattern",  "floor_tan_xpattern",   "floor_slate_xpattern",
    "floor_beige_xpattern", "floor_sea_xpattern",
    "floor_sand_dot",       "floor_dot_b",
]


def find_sprites(img_path: Path, merge_dist=0, min_size=12) -> list:
    """
    Label 8-connected foreground regions (alpha>10), collect bboxes,
    optionally merge nearby bboxes, filter by min_size.
    """
    img = Image.open(img_path).convert("RGBA")
    arr = np.array(img)
    fg = arr[:, :, 3] > 10  # anything with opacity → foreground

    if not fg.any():
        return []

    struct8 = np.ones((3, 3), dtype=bool)
    labeled, n = label(fg, structure=struct8)

    # Collect bounding boxes [y1, x1, y2, x2]
    boxes = []
    for i in range(1, n + 1):
        rows = np.where((labeled == i).any(axis=1))[0]
        cols = np.where((labeled == i).any(axis=0))[0]
        if rows.size == 0:
            continue
        boxes.append([int(rows[0]), int(cols[0]),
                      int(rows[-1]), int(cols[-1])])

    # Optional merge
    if merge_dist > 0:
        changed = True
        while changed:
            changed = False
            used = [False] * len(boxes)
            new_boxes = []
            for i in range(len(boxes)):
                if used[i]:
                    continue
                b = boxes[i][:]
                for j in range(i + 1, len(boxes)):
                    if used[j]:
                        continue
                    bj = boxes[j]
                    if (b[0] - merge_dist <= bj[2] and
                            b[2] + merge_dist >= bj[0] and
                            b[1] - merge_dist <= bj[3] and
                            b[3] + merge_dist >= bj[1]):
                        b[0] = min(b[0], bj[0])
                        b[1] = min(b[1], bj[1])
                        b[2] = max(b[2], bj[2])
                        b[3] = max(b[3], bj[3])
                        used[j] = True
                        changed = True
                new_boxes.append(b)
                used[i] = True
            boxes = new_boxes

    sprites = []
    for y1, x1, y2, x2 in boxes:
        w, h = x2 - x1 + 1, y2 - y1 + 1
        if w >= min_size and h >= min_size:
            sprites.append({"x": int(x1), "y": int(y1),
                             "w": int(w), "h": int(h)})
    sprites.sort(key=lambda s: (s["y"], s["x"]))
    return sprites


def extract_floor_tiles(img_path: Path, cell_w=64, cell_h=64) -> list:
    img = Image.open(img_path).convert("RGBA")
    W, H = img.size
    arr = np.array(img)
    tiles, idx = [], 0
    for row in range(H // cell_h):
        for col in range(W // cell_w):
            x, y = col * cell_w, row * cell_h
            patch = arr[y:y + cell_h, x:x + cell_w]
            if (patch[:, :, 3] < 10).all():
                continue
            name = (FLOOR_NAMES[idx] if idx < len(FLOOR_NAMES)
                    else f"floor_tile_{idx}")
            tiles.append({"id": f"floor_{idx}", "name": name,
                          "x": x, "y": y, "w": cell_w, "h": cell_h})
            idx += 1
    return tiles


def assign_names(sprites, names, prefix):
    return [{**s,
             "id": f"{prefix}_{i}",
             "name": names[i] if i < len(names) else f"{prefix}_item_{i}"}
            for i, s in enumerate(sprites)]


def main():
    configs = [
        {"key": "office1", "file": "B-C-D-E Office 1.png",
         "mode": "sprites", "merge_dist": 0,
         "names": OFFICE1_NAMES, "prefix": "office1"},
        {"key": "office2", "file": "B-C-D-E Office 2.png",
         "mode": "sprites", "merge_dist": 0,
         "names": OFFICE2_NAMES, "prefix": "office2"},
        {"key": "floors",  "file": "A2 Office Floors.png",
         "mode": "floors"},
        {"key": "walls",   "file": "A4 Office Walls.png",
         "mode": "sprites", "merge_dist": 0,
         "names": [], "prefix": "wall"},
    ]

    meta = {"version": "1.0", "tileSize": 16, "tilesets": {}}

    for cfg in configs:
        path = SCRIPT_DIR / cfg["file"]
        if not path.exists():
            print(f"  SKIP: {cfg['file']} not found")
            continue
        print(f"Processing {cfg['file']} ...", end=" ", flush=True)
        img = Image.open(path)
        iw, ih = img.size

        if cfg["mode"] == "floors":
            sprites = extract_floor_tiles(path)
        else:
            raw = find_sprites(path, merge_dist=cfg.get("merge_dist", 0))
            sprites = assign_names(raw, cfg.get("names", []),
                                   cfg.get("prefix", "sprite"))

        meta["tilesets"][cfg["key"]] = {
            "file": cfg["file"],
            "imageWidth": iw, "imageHeight": ih,
            "spriteCount": len(sprites),
            "sprites": sprites,
        }
        print(f"→ {len(sprites)} sprites")

    out = SCRIPT_DIR / "tileset_meta.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Saved {out}")
    for k, v in meta["tilesets"].items():
        print(f"  {k:10s}: {v['spriteCount']:3d} sprites "
              f"({v['imageWidth']}×{v['imageHeight']})")


if __name__ == "__main__":
    main()
