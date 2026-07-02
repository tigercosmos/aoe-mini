import {
  FORAGE_FOOD,
  GOLD_PER_MINE,
  STONE_PER_MINE,
  TREE_WOOD,
  tileIndex,
} from '../shared/constants';
import { ResourceNode, Terrain } from '../shared/enums';
import { rngNext } from '../shared/rng';
import type { MapGenResult, Rng, TileMap } from '../shared/world';

// --- Generation tuning -----------------------------------------------------
const START_RADIUS_FACTOR = 0.35; // players sit on a circle of this * size
const START_MARGIN = 7; // keep the clear box + clusters inside the map
const CLEAR_RADIUS = 6; // 13x13 cleared box around each start
const FOREST_EXCL = 8; // Chebyshev radius kept forest-free around each start
const FOREST_DENSITY = 0.14; // per-tile tree probability elsewhere

const FORAGE_TILES = 6;
const GOLD_TILES = 4;
const STONE_TILES = 3;
const SHEEP_COUNT = 4;

interface Base {
  bx: number; // footprint-center x
  by: number; // footprint-center y
  tcX: number; // Town Center top-left x
  tcY: number; // Town Center top-left y
}

function clampInt(v: number, lo: number, hi: number): number {
  const t = Math.round(v);
  if (t < lo) return lo;
  if (t > hi) return hi;
  return t;
}

function inFootprint(x: number, y: number, tcX: number, tcY: number): boolean {
  return x >= tcX && x < tcX + 4 && y >= tcY && y < tcY + 4;
}

/** Place `count` resource tiles of `node` as a tight spiral around (cx,cy). */
function placeCluster(
  map: TileMap,
  cx: number,
  cy: number,
  count: number,
  node: ResourceNode,
  amount: number,
  tcX: number,
  tcY: number,
): void {
  const size = map.size;
  let placed = 0;
  for (let r = 0; r <= CLEAR_RADIUS && placed < count; r++) {
    for (let dy = -r; dy <= r && placed < count; dy++) {
      const ty = cy + dy;
      if (ty < 0 || ty >= size) continue;
      const horiz = dy === -r || dy === r;
      for (let dx = -r; dx <= r && placed < count; dx++) {
        if (!horiz && dx !== -r && dx !== r) continue; // ring perimeter only
        const tx = cx + dx;
        if (tx < 0 || tx >= size) continue;
        if (inFootprint(tx, ty, tcX, tcY)) continue;
        const idx = tileIndex(size, tx, ty);
        if (map.resourceType[idx] !== ResourceNode.None) continue;
        if (map.terrain[idx] === Terrain.Water) continue;
        map.resourceType[idx] = node;
        map.resourceAmount[idx] = amount;
        placed++;
      }
    }
  }
}

/** Clear a single tile of any resource/water so it becomes walkable. */
function clearTile(map: TileMap, x: number, y: number): void {
  const size = map.size;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = tileIndex(size, x, y);
  map.terrain[idx] = Terrain.Grass;
  map.resourceType[idx] = ResourceNode.None;
  map.resourceAmount[idx] = 0;
}

/** Carve a 4-connected L-shaped walkable corridor (horizontal then vertical). */
function carveCorridor(map: TileMap, x0: number, y0: number, x1: number, y1: number): void {
  const stepX = x1 >= x0 ? 1 : -1;
  for (let x = x0; x !== x1 + stepX; x += stepX) clearTile(map, x, y0);
  const stepY = y1 >= y0 ? 1 : -1;
  for (let y = y0; y !== y1 + stepY; y += stepY) clearTile(map, x1, y);
}

/**
 * Seeded, deterministic map generator. Players are placed on a circle of
 * radius size * 0.35 at evenly spaced angles; each start gets a cleared 13x13
 * box, a tight forage/gold/stone cluster and SHEEP_COUNT sheep spawn points.
 * Forests are scattered elsewhere via the (sim-owned) RNG. L-shaped corridors
 * from every start to the map centre guarantee mutual walkability.
 *
 * Determinism: the ONLY RNG draws happen in the forest-scatter loop, iterated
 * in a fixed (y outer, x inner) order — so the same seed yields byte-identical
 * terrain/resource arrays. Everything else is a pure function of size/count.
 */
export function generateMap(map: TileMap, rng: Rng, playerCount: number): MapGenResult {
  const size = map.size;

  // Reset to a clean all-grass, resource-free, unoccupied baseline.
  map.terrain.fill(Terrain.Grass);
  map.resourceType.fill(ResourceNode.None);
  map.resourceAmount.fill(0);
  map.occupant.fill(-1);

  const center = size / 2;
  const R = size * START_RADIUS_FACTOR;
  const lo = START_MARGIN;
  const hi = size - 1 - START_MARGIN;

  // 1. Start bases on a circle.
  const bases: Base[] = [];
  for (let p = 0; p < playerCount; p++) {
    const angle = (2 * Math.PI * p) / playerCount;
    const bx = clampInt(center + R * Math.cos(angle), lo, hi);
    const by = clampInt(center + R * Math.sin(angle), lo, hi);
    bases.push({ bx, by, tcX: bx - 2, tcY: by - 2 });
  }

  // 2. Scatter forests, drawing RNG for EVERY tile (fixed order) so the
  //    sequence is stable; tiles near any base are left forest-free.
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const roll = rngNext(rng);
      let nearBase = false;
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i];
        if (Math.abs(tx - b.bx) <= FOREST_EXCL && Math.abs(ty - b.by) <= FOREST_EXCL) {
          nearBase = true;
          break;
        }
      }
      if (nearBase) continue;
      if (roll < FOREST_DENSITY) {
        const idx = tileIndex(size, tx, ty);
        map.resourceType[idx] = ResourceNode.Tree;
        map.resourceAmount[idx] = TREE_WOOD;
      }
    }
  }

  // 3. Clear the box around each base (belt-and-suspenders; forests already excluded).
  for (const b of bases) {
    for (let dy = -CLEAR_RADIUS; dy <= CLEAR_RADIUS; dy++) {
      for (let dx = -CLEAR_RADIUS; dx <= CLEAR_RADIUS; dx++) {
        clearTile(map, b.bx + dx, b.by + dy);
      }
    }
  }

  // 4. Resource clusters + sheep spawn points per base.
  const starts: { x: number; y: number }[] = [];
  const sheep: { x: number; y: number }[] = [];
  for (const b of bases) {
    placeCluster(map, b.bx - 4, b.by, FORAGE_TILES, ResourceNode.Forage, FORAGE_FOOD, b.tcX, b.tcY);
    placeCluster(map, b.bx, b.by - 4, GOLD_TILES, ResourceNode.GoldMine, GOLD_PER_MINE, b.tcX, b.tcY);
    placeCluster(map, b.bx + 4, b.by, STONE_TILES, ResourceNode.StoneMine, STONE_PER_MINE, b.tcX, b.tcY);

    starts.push({ x: b.tcX, y: b.tcY });

    const sheepTiles: [number, number][] = [
      [b.bx - 1, b.by + 4],
      [b.bx, b.by + 4],
      [b.bx + 1, b.by + 4],
      [b.bx, b.by + 5],
    ];
    for (let s = 0; s < SHEEP_COUNT; s++) {
      const stx = clampInt(sheepTiles[s][0], 0, size - 1);
      const sty = clampInt(sheepTiles[s][1], 0, size - 1);
      sheep.push({ x: stx + 0.5, y: sty + 0.5 });
    }
  }

  // 5. Corridors to the map centre guarantee inter-start walkability. Routed
  //    one row below each Town Center to avoid clipping the clusters.
  const ccx = clampInt(center, 0, size - 1);
  const ccy = clampInt(center, 0, size - 1);
  for (const b of bases) {
    carveCorridor(map, b.bx, b.by + 2, ccx, ccy);
  }

  return { starts, sheep };
}
