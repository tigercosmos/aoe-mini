import { describe, it, expect } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { movementSystem, clearPath } from '../../src/sim/movement';
import { createStepper } from '../../src/sim/tick';
import {
  CivId,
  EntityKind,
  OrderType,
  UnitType,
} from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { World } from '../../src/shared/world';
import type { SystemSet } from '../../src/shared/interfaces';
import { isWalkable } from '../../src/map/tilemap';
import { tileXOf, tileYOf } from '../../src/shared/constants';

const NOOP_SYSTEMS: SystemSet = {
  production: () => {},
  villager: () => {},
  combat: () => {},
  projectile: () => {},
};

function mkWorld(seed = 11): World {
  return createWorld({
    seed,
    mapSize: 48,
    players: [
      { civ: CivId.Britons, isAI: false },
      { civ: CivId.Franks, isAI: false },
    ],
  });
}

function firstVillagerIdx(w: World, player: PlayerId): number {
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] !== EntityKind.Unit) continue;
    if (w.comp.owner[i] !== player) continue;
    if (w.comp.subtype[i] !== UnitType.Villager) continue;
    return i;
  }
  return -1;
}

/** First walkable tile at Chebyshev distance in [minR, maxR] from (fx,fy). */
function findReachableTarget(
  w: World,
  fx: number,
  fy: number,
  minR: number,
  maxR: number,
): { x: number; y: number } {
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  for (let r = minR; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (isWalkable(w.map, tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
      }
    }
  }
  return { x: fx, y: fy };
}

describe('movementSystem', () => {
  it('paths to a reachable point and arrives Idle', () => {
    const w = mkWorld();
    const v = firstVillagerIdx(w, 1);
    const target = findReachableTarget(w, w.comp.posX[v], w.comp.posY[v], 5, 11);
    w.comp.orderType[v] = OrderType.Move;
    w.comp.orderX[v] = target.x;
    w.comp.orderY[v] = target.y;
    clearPath(w, v);

    let ticks = 0;
    while (w.comp.orderType[v] === OrderType.Move && ticks < 800) {
      movementSystem(w);
      ticks++;
    }

    expect(w.comp.orderType[v]).toBe(OrderType.Idle);
    expect(Math.hypot(w.comp.posX[v] - target.x, w.comp.posY[v] - target.y)).toBeLessThan(0.3);
    expect(ticks).toBeGreaterThan(1);
  });

  it('re-stamps pathVersion without re-pathing when a distant walkability change leaves the next waypoint clear', () => {
    const w = mkWorld();
    const v = firstVillagerIdx(w, 1);
    const target = findReachableTarget(w, w.comp.posX[v], w.comp.posY[v], 9, 14);
    w.comp.orderType[v] = OrderType.Move;
    w.comp.orderX[v] = target.x;
    w.comp.orderY[v] = target.y;
    clearPath(w, v);

    movementSystem(w);
    const v0 = w.pathCache.version;
    const pathRef0 = w.comp.path[v];
    expect(pathRef0).not.toBeNull();
    expect(w.comp.pathVersion[v]).toBe(v0);

    // Distant walkability change: bump the cache version but leave the unit's route clear.
    w.pathCache.version++;
    w.pathCache.entries.clear();
    const v1 = w.pathCache.version;

    movementSystem(w);
    expect(w.comp.pathVersion[v]).toBe(v1); // re-stamped, still valid
    expect(w.comp.path[v]).toBe(pathRef0); // same path (no re-path)
  });

  it('re-paths when the cache version moved AND the next waypoint became unwalkable', () => {
    const w = mkWorld();
    const v = firstVillagerIdx(w, 1);
    const target = findReachableTarget(w, w.comp.posX[v], w.comp.posY[v], 9, 14);
    w.comp.orderType[v] = OrderType.Move;
    w.comp.orderX[v] = target.x;
    w.comp.orderY[v] = target.y;
    clearPath(w, v);

    movementSystem(w);
    const path = w.comp.path[v]!;
    const wpTile = path[w.comp.pathStep[v]];
    const wx = tileXOf(w.mapSize, wpTile);
    const wy = tileYOf(w.mapSize, wpTile);
    // Make ONLY the next waypoint unwalkable (as if a building were placed there).
    w.map.occupant[wpTile] = 0x7fffff;
    w.pathCache.version++;
    w.pathCache.entries.clear();
    const v2 = w.pathCache.version;
    const pathRefBefore = w.comp.path[v];

    movementSystem(w);
    expect(w.comp.pathVersion[v]).toBe(v2); // re-pathed against the new version
    expect(w.comp.path[v]).not.toBe(pathRefBefore); // a fresh route was computed
    // The new route never steps onto the blocked tile.
    const np = w.comp.path[v]!;
    for (let k = 0; k < np.length; k++) expect(np[k]).not.toBe(wpTile);
    expect(isWalkable(w.map, wx, wy)).toBe(false);
  });

  it('snapshots prevX/prevY to the pre-tick position (createStepper)', () => {
    const w = mkWorld();
    const step = createStepper(NOOP_SYSTEMS);
    const v = firstVillagerIdx(w, 1);
    const target = findReachableTarget(w, w.comp.posX[v], w.comp.posY[v], 5, 11);
    w.comp.orderType[v] = OrderType.Move;
    w.comp.orderX[v] = target.x;
    w.comp.orderY[v] = target.y;
    clearPath(w, v);

    const beforeX = w.comp.posX[v];
    const beforeY = w.comp.posY[v];
    step(w, []);

    expect(w.comp.prevX[v]).toBe(beforeX);
    expect(w.comp.prevY[v]).toBe(beforeY);
    // The unit actually advanced this tick.
    const moved = Math.hypot(w.comp.posX[v] - beforeX, w.comp.posY[v] - beforeY);
    expect(moved).toBeGreaterThan(0);
  });
});
