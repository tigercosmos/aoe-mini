import { inBounds, tileIndex, tileXOf, tileYOf } from '../shared/constants';
import type { TileMap } from '../shared/world';
import { isWalkable } from './tilemap';

// 8-directional A* with an octile heuristic and strict no-corner-cutting.
//
// Determinism / performance: the per-tile working arrays (gScore, cameFrom,
// closed-flags) are preallocated once per map capacity and are NEVER cleared
// between calls. Each call bumps a monotonic `gen` counter and stamps every
// tile it touches; a tile's stored data is only trusted when its stamp equals
// the current generation. This makes every search O(reachable region) with no
// O(map) reset cost. The open set is a binary min-heap over parallel typed
// arrays (also reused across calls).

const SQRT2 = Math.SQRT2;
const DIAG_MINUS = SQRT2 - 2; // octile min(dx,dy) coefficient

// 8 neighbour offsets: 4 orthogonal first, then 4 diagonal (fixed order => deterministic tie-breaks).
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

let cap = 0;
let gScore: Float64Array = new Float64Array(0);
let cameFrom: Int32Array = new Int32Array(0);
let stamp: Int32Array = new Int32Array(0); // gen at which gScore/cameFrom for this tile is valid
let closed: Int32Array = new Int32Array(0); // gen at which this tile was finalized
let gen = 0;

// Binary min-heap (parallel arrays, lazy-deletion friendly).
let heapTile: Int32Array = new Int32Array(0);
let heapPrio: Float64Array = new Float64Array(0);
let heapSize = 0;

function ensureCapacity(n: number): void {
  if (n <= cap) return;
  cap = n;
  gScore = new Float64Array(n);
  cameFrom = new Int32Array(n);
  stamp = new Int32Array(n); // zero-filled; gen starts at 1 so stale reads never match
  closed = new Int32Array(n);
  gen = 0;
  const h = Math.max(1024, n);
  heapTile = new Int32Array(h);
  heapPrio = new Float64Array(h);
}

function heapGrow(): void {
  const nc = heapTile.length * 2;
  const nt = new Int32Array(nc);
  const np = new Float64Array(nc);
  nt.set(heapTile);
  np.set(heapPrio);
  heapTile = nt;
  heapPrio = np;
}

function heapPush(tile: number, prio: number): void {
  if (heapSize >= heapTile.length) heapGrow();
  let i = heapSize++;
  heapTile[i] = tile;
  heapPrio[i] = prio;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapPrio[parent] <= heapPrio[i]) break;
    swap(i, parent);
    i = parent;
  }
}

function heapPop(): number {
  const top = heapTile[0];
  const last = --heapSize;
  if (last > 0) {
    heapTile[0] = heapTile[last];
    heapPrio[0] = heapPrio[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < last && heapPrio[l] < heapPrio[smallest]) smallest = l;
      if (r < last && heapPrio[r] < heapPrio[smallest]) smallest = r;
      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
  }
  return top;
}

function swap(a: number, b: number): void {
  const t = heapTile[a];
  heapTile[a] = heapTile[b];
  heapTile[b] = t;
  const p = heapPrio[a];
  heapPrio[a] = heapPrio[b];
  heapPrio[b] = p;
}

function clampCoord(v: number, size: number): number {
  const t = Math.floor(v);
  if (t < 0) return 0;
  if (t >= size) return size - 1;
  return t;
}

/**
 * If (gx,gy) is unwalkable, return the walkable tile nearest to the goal
 * (expanding Chebyshev rings, lowest tile index breaks ties). Returns the
 * goal's own tile index if it is already walkable, or -1 if no walkable tile
 * exists within the whole map.
 */
function resolveGoalTile(map: TileMap, gx: number, gy: number): number {
  const size = map.size;
  if (isWalkable(map, gx, gy)) return tileIndex(size, gx, gy);
  const maxR = size; // guaranteed to cover the map
  for (let r = 1; r <= maxR; r++) {
    let best = -1;
    for (let dy = -r; dy <= r; dy++) {
      const ty = gy + dy;
      if (ty < 0 || ty >= size) continue;
      const onHorizEdge = dy === -r || dy === r;
      for (let dx = -r; dx <= r; dx++) {
        if (!onHorizEdge && dx !== -r && dx !== r) continue;
        const tx = gx + dx;
        if (tx < 0 || tx >= size) continue;
        if (isWalkable(map, tx, ty)) {
          const idx = tileIndex(size, tx, ty);
          if (best === -1 || idx < best) best = idx;
        }
      }
    }
    if (best !== -1) return best;
  }
  return -1;
}

/**
 * 8-direction A* from (sx,sy) to (gx,gy) (world/tile coords; floored to tiles).
 * Octile heuristic, no corner-cutting (a diagonal step requires BOTH shared
 * orthogonal tiles to be walkable). If the goal tile is blocked, routes to the
 * nearest walkable neighbour of the goal instead. Returns the packed tile-index
 * path from start to (effective) goal INCLUSIVE, or null if unreachable.
 * The caller must not mutate the returned array.
 */
export function findPathRaw(
  map: TileMap,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
): Uint16Array | null {
  const size = map.size;
  ensureCapacity(size * size);

  const startX = clampCoord(sx, size);
  const startY = clampCoord(sy, size);
  const goalX = clampCoord(gx, size);
  const goalY = clampCoord(gy, size);

  const startTile = tileIndex(size, startX, startY);
  const goalTile = resolveGoalTile(map, goalX, goalY);
  if (goalTile === -1) return null;

  if (startTile === goalTile) {
    const one = new Uint16Array(1);
    one[0] = startTile;
    return one;
  }

  const gTileX = tileXOf(size, goalTile);
  const gTileY = tileYOf(size, goalTile);

  gen++;
  heapSize = 0;

  gScore[startTile] = 0;
  cameFrom[startTile] = -1;
  stamp[startTile] = gen;
  heapPush(startTile, octile(startX, startY, gTileX, gTileY));

  while (heapSize > 0) {
    const current = heapPop();
    if (closed[current] === gen) continue; // stale duplicate
    closed[current] = gen;

    if (current === goalTile) return reconstruct(startTile, goalTile);

    const cx = tileXOf(size, current);
    const cy = tileYOf(size, current);
    const cg = gScore[current];

    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (!inBounds(size, nx, ny)) continue;
      if (!isWalkable(map, nx, ny)) continue;

      const diagonal = d >= 4;
      let stepCost: number;
      if (diagonal) {
        // No corner cutting: both orthogonal tiles adjacent to the diagonal must be open.
        if (!isWalkable(map, cx + DX[d], cy) || !isWalkable(map, cx, cy + DY[d])) continue;
        stepCost = SQRT2;
      } else {
        stepCost = 1;
      }

      const nTile = tileIndex(size, nx, ny);
      if (closed[nTile] === gen) continue;
      const tentative = cg + stepCost;
      if (stamp[nTile] !== gen || tentative < gScore[nTile]) {
        stamp[nTile] = gen;
        gScore[nTile] = tentative;
        cameFrom[nTile] = current;
        heapPush(nTile, tentative + octile(nx, ny, gTileX, gTileY));
      }
    }
  }

  return null;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + DIAG_MINUS * Math.min(dx, dy);
}

function reconstruct(startTile: number, goalTile: number): Uint16Array {
  // Count length first, then fill (no intermediate array allocation churn).
  let len = 1;
  let t = goalTile;
  while (t !== startTile) {
    t = cameFrom[t];
    len++;
  }
  const path = new Uint16Array(len);
  t = goalTile;
  for (let i = len - 1; i >= 0; i--) {
    path[i] = t;
    if (t !== startTile) t = cameFrom[t];
  }
  return path;
}
