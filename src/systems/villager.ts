// T5 — villager work state machine (gather / drop-off / build).
// Runs as pipeline step 5 (after production, before movement). Because it runs
// BEFORE movementSystem, out-of-range approach is left to movement (which paths
// toward the active gather/build/return target); this system only performs the
// in-range work and the order transitions, calling clearPath on every transition
// so movement re-paths cleanly toward the new destination on the next tick.
//
// Determinism: iterate alive entities by ascending index; no RNG/clock/DOM access.
// Any randomness (none needed here) would come from world.rng only.

import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import {
  EntityKind,
  OrderType,
  UnitType,
  BuildingType,
  ResourceNode,
  Resource,
  GatherSource,
  FLAG_UNDER_CONSTRUCTION,
  nodeToGatherSource,
  gatherSourceToResource,
} from '../shared/enums';
import {
  GATHER_RANGE,
  DEPOSIT_RANGE_PAD,
  RETARGET_NODE_RADIUS,
  tileXOf,
  tileYOf,
} from '../shared/constants';

// Allowed cross-task imports (see review requiredChanges #2 matrix).
import { emit, completeConstruction, findDropOff } from '../sim/actions';
import { clearPath } from '../sim/movement';
import { nearestResourceTile } from '../map/tilemap';
import { gatherRatePerTick, carryCapacity, resolveBuildingStats } from '../content/stats';

/** Inverse of nodeToResource for the tile-gather (Tree/Forage/Gold/Stone) domain. */
function resourceToTileNode(res: Resource): ResourceNode {
  switch (res) {
    case Resource.Wood:
      return ResourceNode.Tree;
    case Resource.Food:
      return ResourceNode.Forage;
    case Resource.Gold:
      return ResourceNode.GoldMine;
    case Resource.Stone:
      return ResourceNode.StoneMine;
    default:
      return ResourceNode.None;
  }
}

export function villagerSystem(world: World): void {
  const { comp, em, map } = world;
  const cap = comp.capacity;
  const size = map.size;

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    if (comp.subtype[i] !== UnitType.Villager) continue;

    switch (comp.orderType[i]) {
      case OrderType.GatherTile:
        gatherTile(world, i, size);
        break;
      case OrderType.GatherEntity:
        gatherEntity(world, i);
        break;
      case OrderType.ReturnResource:
        returnResource(world, i);
        break;
      case OrderType.Build:
        build(world, i);
        break;
      default:
        // Idle / Move / AttackMove / AttackTarget: not handled here.
        break;
    }
  }
}

// --- GatherTile ------------------------------------------------------------

function gatherTile(world: World, i: number, size: number): void {
  const { comp, map } = world;

  const tile = comp.orderTile[i];
  if (tile < 0) {
    goIdleOrReturn(world, i, Resource.Food, false);
    return;
  }

  let node = map.resourceType[tile] as ResourceNode;
  let workTile = tile;

  if (node === ResourceNode.None) {
    // Depleted before we could start (another villager). Retarget by carried type.
    if (comp.carryAmount[i] > 0) {
      const want = resourceToTileNode(comp.carryType[i] as Resource);
      const nt = want === ResourceNode.None ? -1 : nearestResourceTile(map, tile, want, RETARGET_NODE_RADIUS);
      if (nt >= 0) {
        comp.orderTile[i] = nt;
        workTile = nt;
        node = map.resourceType[nt] as ResourceNode;
        clearPath(world, i);
      } else {
        startReturn(world, i, comp.carryType[i] as Resource, -1, -1);
        return;
      }
    } else {
      comp.orderType[i] = OrderType.Idle;
      comp.orderTile[i] = -1;
      clearPath(world, i);
      return;
    }
  }

  const source = nodeToGatherSource(node);
  if (source === -1) {
    comp.orderType[i] = OrderType.Idle;
    comp.orderTile[i] = -1;
    clearPath(world, i);
    return;
  }

  // In range to gather a TILE resource when the villager stands on the resource tile or any of
  // its 8 neighbours. A resource tile is itself unwalkable, so the villager can only ever stand
  // on an adjacent tile; a *diagonally* adjacent tile centre is sqrt(2)=1.414 from the resource
  // centre, which exceeds GATHER_RANGE (1.25) — a Euclidean centre check would leave villagers
  // whose only walkable approach is diagonal permanently unable to gather. Tile (Chebyshev)
  // adjacency is the AoE-correct, footprint-agnostic rule and matches movement's approach stop.
  const wtx = tileXOf(size, workTile);
  const wty = tileYOf(size, workTile);
  const vtx = comp.posX[i] < 0 ? 0 : (comp.posX[i] | 0);
  const vty = comp.posY[i] < 0 ? 0 : (comp.posY[i] | 0);
  const adx = vtx > wtx ? vtx - wtx : wtx - vtx;
  const ady = vty > wty ? vty - wty : wty - vty;
  if (adx > 1 || ady > 1) {
    // Out of range: movement approaches this tick; nothing to do here.
    return;
  }

  const owner = comp.owner[i];
  const capAmt = carryCapacity(world, owner);
  const rate = gatherRatePerTick(world, owner, source);
  comp.workTimer[i] += rate;

  const carried = comp.carryAmount[i];
  const room = capAmt - carried;
  const avail = map.resourceAmount[workTile];
  const take = Math.min(comp.workTimer[i], avail, room);
  if (take > 0) {
    comp.carryAmount[i] = carried + take;
    comp.carryType[i] = gatherSourceToResource(source);
    comp.workTimer[i] -= take;
    map.resourceAmount[workTile] = avail - take;
  }

  // Deplete node?
  if (map.resourceAmount[workTile] <= 0) {
    map.resourceAmount[workTile] = 0;
    map.resourceType[workTile] = ResourceNode.None;
    emit(world, { type: 'resourceNodeDepleted', tile: workTile });
    // Walkability changed (e.g. removed tree opens the tile) -> invalidate cache.
    world.pathCache.version++;
    world.pathCache.entries.clear();
    const nt = nearestResourceTile(world.map, workTile, node, RETARGET_NODE_RADIUS);
    comp.orderTile[i] = nt; // -1 if none
    clearPath(world, i);
  }

  // Carry full -> return; else if node gone with no retarget, return/idle.
  if (comp.carryAmount[i] >= capAmt) {
    startReturn(world, i, comp.carryType[i] as Resource, comp.orderTile[i], -1);
  } else if (comp.orderTile[i] < 0) {
    goIdleOrReturn(world, i, comp.carryType[i] as Resource, comp.carryAmount[i] > 0);
  }
}

// --- GatherEntity (Sheep / Farm) -------------------------------------------

function gatherEntity(world: World, i: number): void {
  const { comp, em } = world;

  const tIdx = resolveHandle(em, comp.orderTarget[i]);
  if (tIdx < 0) {
    goIdleOrReturn(world, i, Resource.Food, comp.carryAmount[i] > 0);
    return;
  }

  const tKind = comp.kind[tIdx];
  const tSub = comp.subtype[tIdx];
  let source: GatherSource;
  let rangeAllow: number;
  if (tKind === EntityKind.Unit && tSub === UnitType.Sheep) {
    source = GatherSource.Sheep;
    rangeAllow = GATHER_RANGE;
  } else if (
    tKind === EntityKind.Building &&
    (comp.flags[tIdx] & FLAG_UNDER_CONSTRUCTION) === 0 &&
    // Farm is the only gatherable building; storesFood > 0 completed building.
    comp.storedResource[tIdx] > 0
  ) {
    source = GatherSource.Farm;
    // Building gather range: dist(center) <= sizeX/2 + GATHER_RANGE (review #8).
    rangeAllow = comp.sizeX[tIdx] / 2 + GATHER_RANGE;
  } else {
    goIdleOrReturn(world, i, Resource.Food, comp.carryAmount[i] > 0);
    return;
  }

  const dx = comp.posX[i] - comp.posX[tIdx];
  const dy = comp.posY[i] - comp.posY[tIdx];
  if (dx * dx + dy * dy > rangeAllow * rangeAllow) {
    return; // movement approaches
  }

  const owner = comp.owner[i];
  const capAmt = carryCapacity(world, owner);
  const rate = gatherRatePerTick(world, owner, source);
  comp.workTimer[i] += rate;

  const carried = comp.carryAmount[i];
  const room = capAmt - carried;
  const avail = comp.storedResource[tIdx];
  const take = Math.min(comp.workTimer[i], avail, room);
  if (take > 0) {
    comp.carryAmount[i] = carried + take;
    comp.carryType[i] = Resource.Food; // sheep + farm both yield food
    comp.workTimer[i] -= take;
    comp.storedResource[tIdx] = avail - take;
  }

  let targetDied = false;
  if (comp.storedResource[tIdx] <= 0) {
    comp.storedResource[tIdx] = 0;
    // review #7: exhausting a sheep/farm kills it via deathSystem (killer = GAIA).
    comp.hp[tIdx] = 0;
    comp.orderTarget[i] = -1;
    targetDied = true;
  }

  if (comp.carryAmount[i] >= capAmt) {
    const resume = targetDied ? -1 : comp.orderTarget[i];
    startReturn(world, i, Resource.Food, -1, resume);
  } else if (targetDied) {
    goIdleOrReturn(world, i, Resource.Food, comp.carryAmount[i] > 0);
  }
}

// --- ReturnResource --------------------------------------------------------

function returnResource(world: World, i: number): void {
  const { comp, em, players } = world;

  const res = comp.carryType[i] as Resource;
  let dIdx = resolveHandle(em, comp.orderTarget[i]);
  if (dIdx < 0) {
    const d = findDropOff(world, i, res);
    if (d < 0) {
      comp.orderType[i] = OrderType.Idle;
      clearPath(world, i);
      return;
    }
    comp.orderTarget[i] = d;
    clearPath(world, i);
    return; // approach next tick
  }

  const range = comp.sizeX[dIdx] / 2 + DEPOSIT_RANGE_PAD;
  const dx = comp.posX[i] - comp.posX[dIdx];
  const dy = comp.posY[i] - comp.posY[dIdx];
  if (dx * dx + dy * dy > range * range) {
    return; // approach
  }

  // Deposit.
  players[comp.owner[i]].resources[res] += comp.carryAmount[i];
  comp.carryAmount[i] = 0;
  comp.workTimer[i] = 0;

  // Resume the interrupted gather job, if any.
  if (comp.resumeTile[i] >= 0) {
    comp.orderType[i] = OrderType.GatherTile;
    comp.orderTile[i] = comp.resumeTile[i];
    comp.resumeTile[i] = -1;
    comp.resumeTarget[i] = -1;
    clearPath(world, i);
  } else if (resolveHandle(em, comp.resumeTarget[i]) >= 0) {
    comp.orderType[i] = OrderType.GatherEntity;
    comp.orderTarget[i] = comp.resumeTarget[i];
    comp.resumeTarget[i] = -1;
    comp.resumeTile[i] = -1;
    clearPath(world, i);
  } else {
    comp.orderType[i] = OrderType.Idle;
    comp.resumeTarget[i] = -1;
    comp.resumeTile[i] = -1;
    clearPath(world, i);
  }
}

// --- Build -----------------------------------------------------------------

function build(world: World, i: number): void {
  const { comp, em } = world;

  const bIdx = resolveHandle(em, comp.orderTarget[i]);
  if (bIdx < 0) {
    comp.orderType[i] = OrderType.Idle;
    clearPath(world, i);
    return;
  }
  if (
    comp.kind[bIdx] !== EntityKind.Building ||
    (comp.flags[bIdx] & FLAG_UNDER_CONSTRUCTION) === 0 ||
    comp.owner[bIdx] !== comp.owner[i]
  ) {
    // Finished or invalid target.
    comp.orderType[i] = OrderType.Idle;
    comp.orderTarget[i] = -1;
    clearPath(world, i);
    return;
  }

  const range = comp.sizeX[bIdx] / 2 + DEPOSIT_RANGE_PAD;
  const dx = comp.posX[i] - comp.posX[bIdx];
  const dy = comp.posY[i] - comp.posY[bIdx];
  if (dx * dx + dy * dy > range * range) {
    return; // approach
  }

  const stats = resolveBuildingStats(world, comp.owner[bIdx], comp.subtype[bIdx] as BuildingType);
  const buildTicks = stats.buildTicks;

  comp.buildProgress[bIdx] += 1;
  const maxHp = comp.maxHp[bIdx];
  const ramped = (maxHp * comp.buildProgress[bIdx]) / buildTicks + 1;
  comp.hp[bIdx] = ramped < maxHp ? ramped : maxHp;

  if (comp.buildProgress[bIdx] >= buildTicks) {
    completeConstruction(world, bIdx);
    comp.orderType[i] = OrderType.Idle;
    comp.orderTarget[i] = -1;
    clearPath(world, i);
  }
}

// --- shared transitions ----------------------------------------------------

/**
 * Switch villager `i` to ReturnResource toward the nearest drop-off for `res`,
 * saving the job to resume after deposit (resumeTile for tile gather, resumeTarget
 * for entity gather; pass -1 for the unused one). Falls back to Idle when no
 * drop-off exists.
 */
function startReturn(
  world: World,
  i: number,
  res: Resource,
  resumeTile: number,
  resumeTarget: number,
): void {
  const { comp } = world;
  const drop = findDropOff(world, i, res);
  if (drop < 0) {
    // Nowhere to deposit: hold position, keep carry, remember job.
    comp.resumeTile[i] = resumeTile;
    comp.resumeTarget[i] = resumeTarget;
    comp.orderType[i] = OrderType.Idle;
    clearPath(world, i);
    return;
  }
  comp.resumeTile[i] = resumeTile;
  comp.resumeTarget[i] = resumeTarget;
  comp.orderType[i] = OrderType.ReturnResource;
  comp.orderTarget[i] = drop;
  clearPath(world, i);
}

/** No node/target left: return the carried load if any, else go Idle. */
function goIdleOrReturn(world: World, i: number, res: Resource, carrying: boolean): void {
  const { comp } = world;
  if (carrying && comp.carryAmount[i] > 0) {
    startReturn(world, i, res, -1, -1);
  } else {
    comp.orderType[i] = OrderType.Idle;
    comp.orderTile[i] = -1;
    comp.orderTarget[i] = -1;
    comp.resumeTile[i] = -1;
    comp.resumeTarget[i] = -1;
    clearPath(world, i);
  }
}
