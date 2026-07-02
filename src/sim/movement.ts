// T4 sim engine — pathing, movement follow, soft separation.
import {
  DEPOSIT_RANGE_PAD,
  GATHER_RANGE,
  SEPARATION_RADIUS,
  tileIndex,
  tileXOf,
  tileYOf,
} from '../shared/constants';
import { EntityKind, OrderType } from '../shared/enums';
import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import { findPath } from '../map/pathcache';
import { isWalkable } from '../map/tilemap';

const EPS = 1e-6;

// Stop radius for approaching a TILE resource: large enough to clear a diagonally adjacent tile
// centre (sqrt(2)=1.414) yet below the next ring (2.0), so the villager halts exactly when it is
// tile-adjacent to the (unwalkable) resource — consistent with villagerSystem's adjacency gather.
const TILE_GATHER_STOP = 1.5;

function clampTile(v: number, size: number): number {
  const t = Math.floor(v);
  if (t < 0) return 0;
  if (t >= size) return size - 1;
  return t;
}

/** Request an A* path from the entity's current tile toward (gx,gy). Stamps pathVersion.
 *  Returns true if a path was found (stored in comp.path/pathStep). */
export function requestPath(world: World, index: number, gx: number, gy: number): boolean {
  const { comp, map, pathCache } = world;
  const size = map.size;
  const sx = clampTile(comp.posX[index], size);
  const sy = clampTile(comp.posY[index], size);
  const gtx = clampTile(gx, size);
  const gty = clampTile(gy, size);
  const path = findPath(map, pathCache, sx, sy, gtx, gty);
  if (path === null || path.length === 0) {
    comp.path[index] = null;
    comp.pathStep[index] = -1;
    return false;
  }
  comp.path[index] = path;
  // path[0] is the start tile; begin heading toward the next waypoint.
  comp.pathStep[index] = path.length > 1 ? 1 : 0;
  comp.pathVersion[index] = pathCache.version;
  return true;
}

/** Drop any active path for an entity (used on arrival or when a work system stops it). */
export function clearPath(world: World, index: number): void {
  world.comp.path[index] = null;
  world.comp.pathStep[index] = -1;
}

interface MoveTarget {
  tx: number;
  ty: number;
  stop: number;
}

/** Resolve where an entity is trying to go this tick, and how close it must get, based on its
 *  current order. Returns null when the order requires no movement or the target is gone. */
function computeTarget(world: World, i: number): MoveTarget | null {
  const { comp, em, map } = world;
  const size = map.size;
  const ot = comp.orderType[i];
  switch (ot) {
    case OrderType.Move:
    case OrderType.AttackMove:
      return { tx: comp.orderX[i], ty: comp.orderY[i], stop: Math.max(0.1, comp.speed[i]) };
    case OrderType.AttackTarget: {
      const t = resolveHandle(em, comp.orderTarget[i]);
      if (t < 0) return null;
      const tr = comp.radius[t];
      const stop =
        comp.attackRange[i] > 0
          ? comp.attackRange[i] + tr
          : comp.radius[i] + tr + 0.2;
      return { tx: comp.posX[t], ty: comp.posY[t], stop };
    }
    case OrderType.GatherTile: {
      const tile = comp.orderTile[i];
      if (tile < 0) return null;
      return {
        tx: tileXOf(size, tile) + 0.5,
        ty: tileYOf(size, tile) + 0.5,
        // Stop once tile-adjacent to the (unwalkable) resource tile. A diagonally adjacent tile
        // centre sits sqrt(2)=1.414 away, so the stop radius must clear that; the next ring is
        // >=2.0 away, so 1.5 cleanly separates "adjacent" (gatherable, see villagerSystem) from
        // "still approaching" and prevents the villager oscillating against the blocked centre.
        stop: TILE_GATHER_STOP,
      };
    }
    case OrderType.GatherEntity: {
      const t = resolveHandle(em, comp.orderTarget[i]);
      if (t < 0) return null;
      const isBuilding = comp.kind[t] === EntityKind.Building;
      const stop = isBuilding ? comp.sizeX[t] / 2 + GATHER_RANGE : GATHER_RANGE;
      return { tx: comp.posX[t], ty: comp.posY[t], stop };
    }
    case OrderType.Build:
    case OrderType.ReturnResource: {
      const t = resolveHandle(em, comp.orderTarget[i]);
      if (t < 0) return null;
      return {
        tx: comp.posX[t],
        ty: comp.posY[t],
        stop: comp.sizeX[t] / 2 + DEPOSIT_RANGE_PAD,
      };
    }
    default:
      return null; // Idle
  }
}

function stepToward(world: World, i: number, tx: number, ty: number, budget: number): number {
  const { comp } = world;
  const dx = tx - comp.posX[i];
  const dy = ty - comp.posY[i];
  const d = Math.hypot(dx, dy);
  if (d <= EPS) return 0;
  const move = Math.min(budget, d);
  comp.posX[i] += (dx / d) * move;
  comp.posY[i] += (dy / d) * move;
  return move;
}

function ensurePath(world: World, i: number, target: MoveTarget): void {
  const { comp, map, pathCache } = world;
  const size = map.size;
  const goalTile = tileIndex(size, clampTile(target.tx, size), clampTile(target.ty, size));
  const path = comp.path[i];
  let need = path === null || comp.pathStep[i] < 0;

  if (!need && path !== null) {
    // Re-path stamp check (review requiredChanges #11): if the cache version moved and the
    // next waypoint is no longer walkable, re-path; otherwise just re-stamp as still valid.
    if (comp.pathVersion[i] !== pathCache.version) {
      const step = comp.pathStep[i];
      const wpTile = path[Math.min(step, path.length - 1)];
      const wx = tileXOf(size, wpTile);
      const wy = tileYOf(size, wpTile);
      if (!isWalkable(map, wx, wy)) need = true;
      else comp.pathVersion[i] = pathCache.version;
    }
    // Moving-target follow: if the goal tile drifted, re-path — but throttle to bound A* cost
    // for chasing (review perf note): only on a per-entity 5-tick cadence.
    if (!need) {
      const lastTile = path[path.length - 1];
      if (lastTile !== goalTile && ((world.tick + i) % 5) === 0) need = true;
    }
  }

  if (need) requestPath(world, i, target.tx, target.ty);
}

function followPath(world: World, i: number, target: MoveTarget): void {
  const { comp, map } = world;
  const size = map.size;
  let budget = comp.speed[i];
  const path = comp.path[i];

  if (path === null || comp.pathStep[i] < 0) {
    // No usable path (unreachable / cache miss) — best-effort straight steer.
    stepToward(world, i, target.tx, target.ty, budget);
    return;
  }

  let guard = path.length + 2;
  while (budget > EPS && comp.pathStep[i] >= 0 && comp.pathStep[i] < path.length && guard-- > 0) {
    const step = comp.pathStep[i];
    const wpTile = path[step];
    let wx = tileXOf(size, wpTile) + 0.5;
    let wy = tileYOf(size, wpTile) + 0.5;
    if (step === path.length - 1) {
      // Final waypoint: steer to the exact target point rather than the tile center.
      wx = target.tx;
      wy = target.ty;
    }
    const moved = stepToward(world, i, wx, wy, budget);
    budget -= moved;
    const rem = Math.hypot(wx - comp.posX[i], wy - comp.posY[i]);
    if (rem <= 1e-3) {
      comp.pathStep[i] = step + 1;
      if (comp.pathStep[i] >= path.length) {
        clearPath(world, i);
        break;
      }
    } else {
      break; // ran out of movement budget before reaching this waypoint
    }
  }
}

function applySeparation(world: World): void {
  const { comp, em, map } = world;
  const size = map.size;
  const cap = comp.capacity;

  // Fresh per-tick integer-tile buckets (avoids the stale spatial grid — see world.ts SpatialGrid
  // doc). Deterministic: insertion + iteration are both ascending index order.
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    const tx = clampTile(comp.posX[i], size);
    const ty = clampTile(comp.posY[i], size);
    const key = ty * size + tx;
    let arr = buckets.get(key);
    if (arr === undefined) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(i);
  }

  const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    if (comp.speed[i] <= 0) continue; // only displace mobile units (review #17g)
    const px = comp.posX[i];
    const py = comp.posY[i];
    const ctx = clampTile(px, size);
    const cty = clampTile(py, size);
    let pushX = 0;
    let pushY = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ny = cty + oy;
      if (ny < 0 || ny >= size) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = ctx + ox;
        if (nx < 0 || nx >= size) continue;
        const arr = buckets.get(ny * size + nx);
        if (arr === undefined) continue;
        for (let a = 0; a < arr.length; a++) {
          const j = arr[a];
          if (j === i) continue;
          const dx = px - comp.posX[j];
          const dy = py - comp.posY[j];
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          if (d2 < EPS) {
            // Exact overlap: deterministic tiny push along +/- x by index order.
            pushX += (i > j ? 1 : -1) * SEPARATION_RADIUS * 0.5;
            continue;
          }
          const d = Math.sqrt(d2);
          const overlap = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
          pushX += (dx / d) * overlap * SEPARATION_RADIUS * 0.5;
          pushY += (dy / d) * overlap * SEPARATION_RADIUS * 0.5;
        }
      }
    }
    if (pushX !== 0 || pushY !== 0) {
      const nx = px + pushX;
      const ny = py + pushY;
      if (isWalkable(map, Math.floor(nx), Math.floor(ny))) {
        comp.posX[i] = nx;
        comp.posY[i] = ny;
      }
    }
  }
}

/** Move all mobile units toward their order target, following A* paths, then apply soft
 *  separation and rebuild the spatial grid (end-of-tick). */
export function movementSystem(world: World): void {
  const { comp, em } = world;
  const cap = comp.capacity;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    if (comp.speed[i] <= 0) continue;

    const target = computeTarget(world, i);
    if (target === null) {
      clearPath(world, i);
      continue;
    }
    // Tile-gather arrival: a resource tile's centre is unwalkable, so the villager can never sit
    // on it and a Euclidean stop check may never trip — the path's last tile can never equal the
    // (blocked) goal tile, so ensurePath's moving-target branch would re-path every 5 ticks,
    // jiggling the villager in and out of gather range and roughly halving its throughput. Once
    // the villager stands on a tile Chebyshev-adjacent to the resource (exactly villagerSystem's
    // gather condition), it has arrived: stop and hold so it gathers every tick.
    if (comp.orderType[i] === OrderType.GatherTile) {
      const gtile = comp.orderTile[i];
      if (gtile >= 0) {
        const size = world.map.size;
        const wtx = gtile % size;
        const wty = (gtile / size) | 0;
        const vtx = comp.posX[i] < 0 ? 0 : (comp.posX[i] | 0);
        const vty = comp.posY[i] < 0 ? 0 : (comp.posY[i] | 0);
        if ((vtx > wtx ? vtx - wtx : wtx - vtx) <= 1 && (vty > wty ? vty - wty : wty - vty) <= 1) {
          clearPath(world, i);
          continue;
        }
      }
    }
    const dist = Math.hypot(target.tx - comp.posX[i], target.ty - comp.posY[i]);
    if (dist <= target.stop) {
      clearPath(world, i);
      if (comp.orderType[i] === OrderType.Move) comp.orderType[i] = OrderType.Idle;
      continue;
    }
    ensurePath(world, i, target);
    followPath(world, i, target);
  }

  applySeparation(world);
  world.grid.rebuild(em, comp);
}
