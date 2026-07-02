// src/ui/picking.ts
// Pure screen<->world picking helpers shared by the input controller and the HUD.
// Depends ONLY on the frozen shared iso math + world.grid / world.comp / world.map — no
// renderer dependency, no sim mutation. All functions are deterministic and allocation-light
// (module-level scratch buffers reused across calls; single-threaded browser/Node use only).

import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import type { PlayerId, BuildingType } from '../shared/enums';
import { EntityKind } from '../shared/enums';
import { resolveHandle } from '../shared/world';
import { worldToScreen, screenToWorld } from '../shared/iso';
import type { Vec2 } from '../shared/iso';
import { inBounds, tileIndex, QUERY_BUFFER_SIZE } from '../shared/constants';

/**
 * Building footprint sizes (tiles) keyed by BuildingType. UI-only metadata mirroring the frozen
 * contentDesign footprints — used for placement-ghost validity (input) and the build menu (hud).
 * Existing buildings are hit-tested from comp.sizeX/sizeY instead; this table covers the ghost of a
 * not-yet-spawned building (which has no entity, hence no comp slot).
 */
export const BUILDING_FOOTPRINT: Readonly<Record<BuildingType, { sizeX: number; sizeY: number }>> = {
  0: { sizeX: 4, sizeY: 4 }, // TownCenter
  1: { sizeX: 2, sizeY: 2 }, // House
  2: { sizeX: 2, sizeY: 2 }, // Mill
  3: { sizeX: 2, sizeY: 2 }, // LumberCamp
  4: { sizeX: 2, sizeY: 2 }, // MiningCamp
  5: { sizeX: 2, sizeY: 2 }, // Farm
  6: { sizeX: 3, sizeY: 3 }, // Barracks
  7: { sizeX: 3, sizeY: 3 }, // ArcheryRange
  8: { sizeX: 3, sizeY: 3 }, // Stable
  9: { sizeX: 3, sizeY: 3 }, // Blacksmith
  10: { sizeX: 4, sizeY: 4 }, // Castle
};

// Minimum unit pick radius in tiles so small units (villager radius 0.3) stay clickable.
const MIN_UNIT_PICK_RADIUS = 0.5;
// queryCircle radius (tiles) around the cursor world-point when hit-testing entities.
const ENTITY_QUERY_RADIUS = 1.5;

const scratchVec: Vec2 = { x: 0, y: 0 };
const scratchQuery = new Int32Array(QUERY_BUFFER_SIZE);

/** Screen (canvas CSS px) -> tile index under the given camera view, or -1 if off-map. */
export function pickTile(view: ViewState, px: number, py: number, mapSize: number): number {
  screenToWorld(view, px, py, scratchVec);
  const tx = Math.floor(scratchVec.x);
  const ty = Math.floor(scratchVec.y);
  if (!inBounds(mapSize, tx, ty)) return -1;
  return tileIndex(mapSize, tx, ty);
}

/** True if tile at (tx,ty) has been explored by `player` (fog: ever-seen). */
function tileExplored(world: World, tx: number, ty: number, player: PlayerId): boolean {
  const size = world.map.size;
  if (!inBounds(size, tx, ty)) return false;
  const bit = 1 << player;
  return (world.map.explored[tileIndex(size, tx, ty)] & bit) !== 0;
}

/**
 * Pick the entity under a screen point. Returns an entity HANDLE or -1.
 * Rules (per spec): queryCircle ENTITY_QUERY_RADIUS around the cursor world point; hit-test units by
 * radius and buildings by footprint; prefer units over buildings, then highest (posY+posX) [front-most
 * in iso], then lowest index; only entities whose center tile is explored by view.localPlayer.
 */
export function pickEntity(world: World, view: ViewState, px: number, py: number): number {
  screenToWorld(view, px, py, scratchVec);
  const wx = scratchVec.x;
  const wy = scratchVec.y;
  const comp = world.comp;
  const em = world.em;
  const n = world.grid.queryCircle(wx, wy, ENTITY_QUERY_RADIUS, scratchQuery);

  let bestHandle = -1;
  let bestIsUnit = false;
  let bestDepth = -Infinity;
  let bestIndex = -1;

  for (let k = 0; k < n; k++) {
    const i = scratchQuery[k];
    if (em.alive[i] !== 1) continue;
    const kind = comp.kind[i];
    if (kind === EntityKind.Projectile) continue;

    const ex = comp.posX[i];
    const ey = comp.posY[i];

    // Fog: only pick entities on tiles the local player has explored.
    if (!tileExplored(world, Math.floor(ex), Math.floor(ey), view.localPlayer)) continue;

    let hit = false;
    if (kind === EntityKind.Unit) {
      const r = Math.max(comp.radius[i], MIN_UNIT_PICK_RADIUS);
      const dx = wx - ex;
      const dy = wy - ey;
      hit = dx * dx + dy * dy <= r * r;
    } else {
      // Building: footprint centered at (posX,posY) with half-extents sizeX/2, sizeY/2.
      const hx = comp.sizeX[i] / 2;
      const hy = comp.sizeY[i] / 2;
      hit = Math.abs(wx - ex) <= hx && Math.abs(wy - ey) <= hy;
    }
    if (!hit) continue;

    const isUnit = kind === EntityKind.Unit;
    const depth = ey + ex;
    let better: boolean;
    if (bestHandle === -1) {
      better = true;
    } else if (isUnit !== bestIsUnit) {
      better = isUnit; // units always preferred over buildings
    } else if (depth !== bestDepth) {
      better = depth > bestDepth; // front-most (largest posY+posX)
    } else {
      better = i < bestIndex; // tie -> lowest index
    }
    if (better) {
      bestHandle = em.handleFor(i);
      bestIsUnit = isUnit;
      bestDepth = depth;
      bestIndex = i;
    }
  }
  return bestHandle;
}

/**
 * Box-select: all alive UNITS owned by `ownedBy` whose interpolated screen position falls inside the
 * screen-space rectangle (x0,y0)-(x1,y1). Returns entity HANDLES sorted ascending. Buildings excluded.
 */
export function entitiesInScreenRect(
  world: World,
  view: ViewState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ownedBy: PlayerId,
): number[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const comp = world.comp;
  const em = world.em;
  const out: number[] = [];
  for (let i = 0; i < comp.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    if (comp.owner[i] !== ownedBy) continue;
    worldToScreen(view, comp.posX[i], comp.posY[i], scratchVec);
    if (scratchVec.x < minX || scratchVec.x > maxX || scratchVec.y < minY || scratchVec.y > maxY) continue;
    out.push(em.handleFor(i));
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Re-resolve a selection to only handles that still point at a live entity, sorted ascending. */
export function pruneSelection(world: World, selection: number[]): number[] {
  const em = world.em;
  const kept: number[] = [];
  for (const h of selection) {
    if (resolveHandle(em, h) >= 0) kept.push(h);
  }
  kept.sort((a, b) => a - b);
  return kept;
}
