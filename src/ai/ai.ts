// src/ai/ai.ts
//
// AI opponent entry point + shared AI knowledge (data tables + read-only World helpers)
// used by the econ/military sub-planners.
//
// CONTRACT (see interfaces.ts AIPlayer + design T6):
//  - think(world) returns [] on non-think ticks (tick % thinkInterval !== player % thinkInterval).
//  - think NEVER mutates world (read-only) and NEVER touches world.rng — it uses only a private
//    mulberry32 rng seeded (matchSeed ^ (player * 0x9E3779B9)) from src/shared/rng.
//  - think emits JSON-serializable Commands only, bounded to ~8 per think.
//
// This module intentionally forms a small dependency cycle with ./econ and ./military:
// ai.ts owns the shared helpers/data and imports the two planners; the planners import the
// helpers/data back. This is safe under ES modules because the cross-module bindings are only
// ever read inside function bodies (at call time), never at module-evaluation time.

import {
  GAIA,
  Age,
  BuildingType,
  UnitType,
  TechId,
  Resource,
  ResourceNode,
  Terrain,
  EntityKind,
  OrderType,
  CivId,
  MatchStatus,
  BUILDING_TYPE_COUNT,
  FLAG_UNDER_CONSTRUCTION,
  nodeToResource,
} from '../shared/enums';
import { tileIndex, tileXOf, tileYOf } from '../shared/constants';
import { createRng, rngInt } from '../shared/rng';
import type { PlayerId } from '../shared/enums';
import type { World, PlayerState, Rng } from '../shared/world';
import type { Command } from '../shared/commands';
import type { AIConfig, AIPlayer } from '../shared/interfaces';
import { planEconomy } from './econ';
import { planMilitary } from './military';

// ------------------------------------------------------------------ tuning ---

export const DEFAULT_AI_CONFIG: AIConfig = { maxVillagers: 18, attackArmySize: 12, thinkInterval: 10 };

export const AI_MAX_COMMANDS = 8;   // hard cap on commands emitted per think
export const ECON_BUDGET = 5;       // commands the economy planner may contribute
export const MIL_BUDGET = 5;        // commands the military planner may contribute

export const RESOURCE_SEARCH_RADIUS = 40; // ring radius (tiles) when locating a resource node
export const PLACE_SEARCH_RADIUS = 24;    // spiral radius (tiles) when locating a build spot
export const CAMP_DISTANCE_THRESHOLD = 6; // build a drop-off camp when a node is farther than this
export const TC_QUEUE_MAX = 2;            // stop queueing villagers at a Town Center past this depth
export const MIL_QUEUE_MAX = 2;           // stop queueing units at a military building past this depth
export const POP_BUFFER = 3;              // build a House once (cap - pop) drops to this or below
export const TECH_AFFORD_MULT = 1.5;      // research an upgrade only when resources exceed 1.5x its cost
export const POP_CAP_HARD = 200;          // never build houses past this (mirrors POP_CAP_MAX)
export const BUILDER_MIN_GATHERERS = 2;   // always keep at least this many villagers gathering
export const BUILDER_GATHER_KEEP = 0.6;   // keep >= this fraction of the workforce gathering; draft the rest

// ------------------------------------------------------------ data tables ----
// Base costs [Food, Wood, Gold, Stone]. Civ bonuses only ever REDUCE cost, so checking against
// the base cost is a safe (slightly conservative) affordability test — the sim does the exact math.

export type Cost4 = readonly [number, number, number, number];

export interface BuildInfo {
  cost: Cost4;
  size: number;               // square footprint (sizeX === sizeY for every building)
  age: Age;                   // minimum age
  reqBuilding: BuildingType | -1;
}

export const BUILD_INFO: Record<number, BuildInfo> = {
  [BuildingType.TownCenter]:  { cost: [0, 275, 0, 100], size: 4, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.House]:       { cost: [0, 25, 0, 0],    size: 2, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.Mill]:        { cost: [0, 100, 0, 0],   size: 2, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.LumberCamp]:  { cost: [0, 100, 0, 0],   size: 2, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.MiningCamp]:  { cost: [0, 100, 0, 0],   size: 2, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.Farm]:        { cost: [0, 60, 0, 0],    size: 2, age: Age.Dark,   reqBuilding: BuildingType.Mill },
  [BuildingType.Barracks]:    { cost: [0, 175, 0, 0],   size: 3, age: Age.Dark,   reqBuilding: -1 },
  [BuildingType.ArcheryRange]:{ cost: [0, 175, 0, 0],   size: 3, age: Age.Feudal, reqBuilding: BuildingType.Barracks },
  [BuildingType.Stable]:      { cost: [0, 175, 0, 0],   size: 3, age: Age.Feudal, reqBuilding: BuildingType.Barracks },
  [BuildingType.Blacksmith]:  { cost: [0, 150, 0, 0],   size: 3, age: Age.Feudal, reqBuilding: -1 },
  [BuildingType.Castle]:      { cost: [0, 0, 0, 650],   size: 4, age: Age.Castle, reqBuilding: -1 },
};

export interface UnitInfo {
  cost: Cost4;
  pop: number;
  trainedAt: BuildingType;
  age: Age;
  tech: TechId | -1;          // required researched tech, or -1
}

export const UNIT_INFO: Record<number, UnitInfo> = {
  [UnitType.Villager]:       { cost: [50, 0, 0, 0],  pop: 1, trainedAt: BuildingType.TownCenter,  age: Age.Dark,   tech: -1 },
  [UnitType.Militia]:        { cost: [60, 0, 20, 0], pop: 1, trainedAt: BuildingType.Barracks,    age: Age.Dark,   tech: -1 },
  [UnitType.ManAtArms]:      { cost: [60, 0, 20, 0], pop: 1, trainedAt: BuildingType.Barracks,    age: Age.Feudal, tech: TechId.ManAtArmsUpgrade },
  [UnitType.Spearman]:       { cost: [35, 25, 0, 0], pop: 1, trainedAt: BuildingType.Barracks,    age: Age.Feudal, tech: -1 },
  [UnitType.Archer]:         { cost: [0, 25, 45, 0], pop: 1, trainedAt: BuildingType.ArcheryRange, age: Age.Feudal, tech: -1 },
  [UnitType.ScoutCavalry]:   { cost: [80, 0, 0, 0],  pop: 1, trainedAt: BuildingType.Stable,      age: Age.Feudal, tech: -1 },
  [UnitType.Knight]:         { cost: [60, 0, 75, 0], pop: 1, trainedAt: BuildingType.Stable,      age: Age.Castle, tech: -1 },
  [UnitType.Longbowman]:     { cost: [0, 35, 40, 0], pop: 1, trainedAt: BuildingType.Castle,      age: Age.Castle, tech: -1 },
  [UnitType.ThrowingAxeman]: { cost: [55, 0, 25, 0], pop: 1, trainedAt: BuildingType.Castle,      age: Age.Castle, tech: -1 },
  [UnitType.Mangudai]:       { cost: [0, 55, 65, 0], pop: 1, trainedAt: BuildingType.Castle,      age: Age.Castle, tech: -1 },
};

export interface TechInfo {
  cost: Cost4;
  at: BuildingType;
  age: Age;                   // minimum current age to research
  reqTech: TechId | -1;
  reqBuilding: BuildingType | -1;
}

export const TECH_INFO: Record<number, TechInfo> = {
  [TechId.Loom]:             { cost: [0, 0, 50, 0],     at: BuildingType.TownCenter, age: Age.Dark,   reqTech: -1,                  reqBuilding: -1 },
  [TechId.Wheelbarrow]:      { cost: [175, 50, 0, 0],   at: BuildingType.TownCenter, age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.ManAtArmsUpgrade]: { cost: [100, 0, 40, 0],   at: BuildingType.Barracks,   age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.Forging]:          { cost: [150, 0, 0, 0],    at: BuildingType.Blacksmith, age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.IronCasting]:      { cost: [220, 0, 120, 0],  at: BuildingType.Blacksmith, age: Age.Castle, reqTech: TechId.Forging,      reqBuilding: -1 },
  [TechId.Fletching]:        { cost: [100, 0, 50, 0],   at: BuildingType.Blacksmith, age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.BodkinArrow]:      { cost: [200, 0, 100, 0],  at: BuildingType.Blacksmith, age: Age.Castle, reqTech: TechId.Fletching,    reqBuilding: -1 },
  [TechId.ScaleMailArmor]:   { cost: [100, 0, 0, 0],    at: BuildingType.Blacksmith, age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.ChainMailArmor]:   { cost: [200, 0, 100, 0],  at: BuildingType.Blacksmith, age: Age.Castle, reqTech: TechId.ScaleMailArmor, reqBuilding: -1 },
  [TechId.ScaleBardingArmor]:{ cost: [150, 0, 0, 0],    at: BuildingType.Blacksmith, age: Age.Feudal, reqTech: -1,                  reqBuilding: -1 },
  [TechId.FeudalAge]:        { cost: [500, 0, 0, 0],    at: BuildingType.TownCenter, age: Age.Dark,   reqTech: -1,                  reqBuilding: BuildingType.Barracks },
  [TechId.CastleAge]:        { cost: [800, 0, 200, 0],  at: BuildingType.TownCenter, age: Age.Feudal, reqTech: TechId.FeudalAge,    reqBuilding: BuildingType.Blacksmith },
  [TechId.ImperialAge]:      { cost: [1000, 0, 800, 0], at: BuildingType.TownCenter, age: Age.Castle, reqTech: TechId.CastleAge,    reqBuilding: BuildingType.Castle },
};

/** The Castle-trained unique unit for a civ. */
export function uniqueUnitOf(civ: CivId): UnitType {
  switch (civ) {
    case CivId.Franks: return UnitType.ThrowingAxeman;
    case CivId.Mongols: return UnitType.Mangudai;
    case CivId.Britons:
    default: return UnitType.Longbowman;
  }
}

/** Age -> the tech that advances to the NEXT age, or -1 in Imperial. */
export function nextAgeTech(age: Age): TechId | -1 {
  if (age === Age.Dark) return TechId.FeudalAge;
  if (age === Age.Feudal) return TechId.CastleAge;
  if (age === Age.Castle) return TechId.ImperialAge;
  return -1;
}

// -------------------------------------------------------- world read helpers -

export interface PlayerScan {
  ps: PlayerState;
  villagers: number[];              // alive villager indices, ascending
  idleVillagers: number[];          // villagers with OrderType.Idle
  army: number[];                   // alive military unit indices (not Villager/Sheep)
  idleArmy: number[];               // military with OrderType.Idle
  completeByType: number[][];       // [BuildingType] -> completed building indices
  underConstruction: number[][];    // [BuildingType] -> under-construction building indices
  tc: number;                       // first completed Town Center index, or -1
}

/** Single O(capacity) pass collecting everything a planner needs about `player`. Read-only. */
export function scanPlayer(world: World, player: PlayerId): PlayerScan {
  const em = world.em;
  const comp = world.comp;
  const cap = comp.capacity;
  const completeByType: number[][] = [];
  const underConstruction: number[][] = [];
  for (let b = 0; b < BUILDING_TYPE_COUNT; b++) {
    completeByType.push([]);
    underConstruction.push([]);
  }
  const villagers: number[] = [];
  const idleVillagers: number[] = [];
  const army: number[] = [];
  const idleArmy: number[] = [];
  let tc = -1;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1 || comp.owner[i] !== player) continue;
    const kind = comp.kind[i];
    if (kind === EntityKind.Unit) {
      const st = comp.subtype[i];
      if (st === UnitType.Villager) {
        villagers.push(i);
        if (comp.orderType[i] === OrderType.Idle) idleVillagers.push(i);
      } else if (st !== UnitType.Sheep) {
        army.push(i);
        if (comp.orderType[i] === OrderType.Idle) idleArmy.push(i);
      }
    } else if (kind === EntityKind.Building) {
      const st = comp.subtype[i];
      if (st >= 0 && st < BUILDING_TYPE_COUNT) {
        if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) {
          underConstruction[st].push(i);
        } else {
          completeByType[st].push(i);
          if (st === BuildingType.TownCenter && tc === -1) tc = i;
        }
      }
    }
  }
  return { ps: world.players[player], villagers, idleVillagers, army, idleArmy, completeByType, underConstruction, tc };
}

/** True if `player` owns a completed building of the given type. */
export function hasCompleted(scan: PlayerScan, bt: BuildingType): boolean {
  return scan.completeByType[bt].length > 0;
}

/** Completed + under-construction count of a building type. */
export function existingCount(scan: PlayerScan, bt: BuildingType): number {
  return scan.completeByType[bt].length + scan.underConstruction[bt].length;
}

export function canAfford(ps: PlayerState, cost: Cost4, mul = 1): boolean {
  const r = ps.resources;
  return (
    r[Resource.Food] >= cost[0] * mul &&
    r[Resource.Wood] >= cost[1] * mul &&
    r[Resource.Gold] >= cost[2] * mul &&
    r[Resource.Stone] >= cost[3] * mul
  );
}

/** Entity handle for a live entity index (read-only; identifies the entity in a Command). */
export function handleOf(world: World, index: number): number {
  return world.em.handleFor(index);
}

export function queueLen(world: World, index: number): number {
  const q = world.comp.queue[index];
  return q ? q.length : 0;
}

export function queueHasTech(world: World, index: number, tech: TechId): boolean {
  const q = world.comp.queue[index];
  if (!q) return false;
  for (let k = 0; k < q.length; k++) {
    const it = q[k];
    if (it.kind === 'tech' && it.tech === tech) return true;
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Villagers eligible to be drafted for construction, in reservation priority:
 * idle villagers first (drafting them costs no gathering), then villagers currently
 * gathering / returning / moving (a temporary pull — the villager auto-returns to Idle when the
 * building completes and is reassigned to gather on a later think). Villagers already in a Build
 * order are excluded so we never yank a builder off an in-progress structure. Ascending index
 * within each group keeps selection deterministic.
 *
 * WHY: the economy runs with every villager gathering, so idle villagers are almost never
 * available. If construction could only ever use idle villagers, Houses would stop being built
 * once the economy ramps, the population cap would freeze, the army could never reach
 * attackArmySize, and every match would stalemate. Drafting an active gatherer is the AoE-correct
 * behaviour and is what unblocks age/army progression.
 */
export function reservableBuilders(world: World, scan: PlayerScan): number[] {
  const out: number[] = [];
  for (let k = 0; k < scan.idleVillagers.length; k++) out.push(scan.idleVillagers[k]);
  const c = world.comp;
  // Collect the active gatherers (ascending) available to draft.
  const gatherers: number[] = [];
  for (let k = 0; k < scan.villagers.length; k++) {
    const i = scan.villagers[k];
    const ot = c.orderType[i];
    if (ot === OrderType.Idle || ot === OrderType.Build) continue; // idle already added; skip active builders
    gatherers.push(i);
  }
  // Keep a floor of the workforce gathering so construction never guts the economy. Early on
  // (3 villagers) this keeps 2 on resources and offers at most 1 for building, which is what
  // lets the opening economy stay net-positive; later it still frees plenty of hands to build
  // Houses/military. Idle villagers are always offered (they cost no gathering to draft).
  const keep = Math.max(BUILDER_MIN_GATHERERS, Math.ceil(gatherers.length * BUILDER_GATHER_KEEP));
  const draftable = gatherers.length - keep;
  for (let k = 0; k < draftable; k++) out.push(gatherers[k]);
  return out;
}

/** Top-left footprint tile index of a building entity. */
export function buildingTopLeftTile(world: World, index: number): number {
  const c = world.comp;
  const size = world.map.size;
  const sx = c.sizeX[index] || 1;
  const sy = c.sizeY[index] || 1;
  const tx = clamp(Math.round(c.posX[index] - sx / 2), 0, size - 1);
  const ty = clamp(Math.round(c.posY[index] - sy / 2), 0, size - 1);
  return tileIndex(size, tx, ty);
}

/** A stable "home" tile for spiral/ring searches: the TC, else first villager, else map center. */
export function refTile(world: World, scan: PlayerScan): number {
  const size = world.map.size;
  if (scan.tc >= 0) return buildingTopLeftTile(world, scan.tc);
  if (scan.villagers.length > 0) {
    const i = scan.villagers[0];
    return tileIndex(size, clamp(Math.floor(world.comp.posX[i]), 0, size - 1), clamp(Math.floor(world.comp.posY[i]), 0, size - 1));
  }
  if (scan.army.length > 0) {
    const i = scan.army[0];
    return tileIndex(size, clamp(Math.floor(world.comp.posX[i]), 0, size - 1), clamp(Math.floor(world.comp.posY[i]), 0, size - 1));
  }
  return tileIndex(size, size >> 1, size >> 1);
}

export function tileCenterX(world: World, tile: number): number {
  return tileXOf(world.map.size, tile) + 0.5;
}
export function tileCenterY(world: World, tile: number): number {
  return tileYOf(world.map.size, tile) + 0.5;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Nearest tile of `node` (with amount > 0) to `fromTile`, by Chebyshev ring; tie -> lowest tile index. */
export function findNearestNode(world: World, fromTile: number, node: ResourceNode, maxRadius: number): number {
  const map = world.map;
  const size = map.size;
  const fx = tileXOf(size, fromTile);
  const fy = tileYOf(size, fromTile);
  const rt = map.resourceType;
  const ra = map.resourceAmount;
  for (let r = 0; r <= maxRadius; r++) {
    let best = -1;
    const y0 = fy - r;
    const y1 = fy + r;
    const x0 = fx - r;
    const x1 = fx + r;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= size) continue;
      const onYEdge = y === y0 || y === y1;
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= size) continue;
        if (r > 0 && !onYEdge && x !== x0 && x !== x1) continue; // perimeter only
        const t = y * size + x;
        if (rt[t] === node && ra[t] > 0) {
          if (best === -1 || t < best) best = t;
        }
      }
    }
    if (best !== -1) return best;
  }
  return -1;
}

/** Footprint walkability check mirroring T2's canPlaceBuilding (in-bounds, land, no node, no occupant). */
export function aiCanPlace(world: World, tileX: number, tileY: number, sizeX: number, sizeY: number): boolean {
  const map = world.map;
  const size = map.size;
  for (let dy = 0; dy < sizeY; dy++) {
    for (let dx = 0; dx < sizeX; dx++) {
      const x = tileX + dx;
      const y = tileY + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      const t = y * size + x;
      if (map.terrain[t] === Terrain.Water) return false;
      if (map.resourceType[t] !== ResourceNode.None) return false;
      if (map.occupant[t] !== -1) return false;
    }
  }
  return true;
}

/**
 * Spiral outward from `nearTile` (with a small rng jitter to spread AI structures) for a
 * placeable size x size footprint. Returns the top-left {tileX,tileY} or null.
 */
export function findPlacement(
  world: World,
  nearTile: number,
  size: number,
  rng: Rng,
  maxRadius: number,
): { tileX: number; tileY: number } | null {
  const mapSize = world.map.size;
  const ox = clamp(tileXOf(mapSize, nearTile) + (rngInt(rng, 3) - 1), 0, mapSize - 1);
  const oy = clamp(tileYOf(mapSize, nearTile) + (rngInt(rng, 3) - 1), 0, mapSize - 1);
  for (let r = 1; r <= maxRadius; r++) {
    const y0 = oy - r;
    const y1 = oy + r;
    const x0 = ox - r;
    const x1 = ox + r;
    for (let y = y0; y <= y1; y++) {
      const onYEdge = y === y0 || y === y1;
      for (let x = x0; x <= x1; x++) {
        if (!onYEdge && x !== x0 && x !== x1) continue; // ring perimeter only
        if (aiCanPlace(world, x, y, size, size)) return { tileX: x, tileY: y };
      }
    }
  }
  return null;
}

/** Minimum euclidean distance from (px,py) to the center of any building in `indices`; Infinity if none. */
export function minDistToBuildings(world: World, px: number, py: number, indices: number[]): number {
  let best = Infinity;
  const c = world.comp;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const d = dist2(px, py, c.posX[i], c.posY[i]);
    if (d < best) best = d;
  }
  return best === Infinity ? Infinity : Math.sqrt(best);
}

/** Nearest gaia Sheep (storedResource > 0) to (px,py); returns a HANDLE or -1. Tie -> lowest index. */
export function findNearestSheep(world: World, px: number, py: number): number {
  const em = world.em;
  const c = world.comp;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < c.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    if (c.kind[i] !== EntityKind.Unit || c.subtype[i] !== UnitType.Sheep) continue;
    if (c.owner[i] !== GAIA || c.storedResource[i] <= 0) continue;
    const d = dist2(px, py, c.posX[i], c.posY[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? handleOf(world, best) : -1;
}

/** Nearest own completed Farm (food remaining) to (px,py); returns a HANDLE or -1. Tie -> lowest index. */
export function findNearestOwnFarm(world: World, player: PlayerId, px: number, py: number): number {
  const em = world.em;
  const c = world.comp;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < c.capacity; i++) {
    if (em.alive[i] !== 1 || c.owner[i] !== player) continue;
    if (c.kind[i] !== EntityKind.Building || c.subtype[i] !== BuildingType.Farm) continue;
    if ((c.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0 || c.storedResource[i] <= 0) continue;
    const d = dist2(px, py, c.posX[i], c.posY[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? handleOf(world, best) : -1;
}

/** Nearest enemy (non-gaia, not `player`) Town Center to (px,py); returns an ENTITY INDEX or -1. */
export function findNearestEnemyTC(world: World, player: PlayerId, px: number, py: number): number {
  const em = world.em;
  const c = world.comp;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < c.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    const owner = c.owner[i];
    if (owner === player || owner === GAIA) continue;
    if (c.kind[i] !== EntityKind.Building || c.subtype[i] !== BuildingType.TownCenter) continue;
    const d = dist2(px, py, c.posX[i], c.posY[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Nearest enemy (non-gaia, not `player`) unit or building to (px,py); returns an ENTITY INDEX or -1. */
export function findNearestEnemyEntity(world: World, player: PlayerId, px: number, py: number): number {
  const em = world.em;
  const c = world.comp;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < c.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    const owner = c.owner[i];
    if (owner === player || owner === GAIA) continue;
    if (c.kind[i] === EntityKind.Projectile) continue;
    const d = dist2(px, py, c.posX[i], c.posY[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Which resource a villager is currently working toward, or -1 (idle / building / unknown). */
export function villagerResource(world: World, i: number): Resource | -1 {
  const c = world.comp;
  const ot = c.orderType[i];
  if (ot === OrderType.GatherTile) {
    const tile = c.orderTile[i];
    if (tile >= 0) return nodeToResource(world.map.resourceType[tile] as ResourceNode);
    return -1;
  }
  if (ot === OrderType.GatherEntity) return Resource.Food; // sheep or farm
  if (ot === OrderType.ReturnResource) {
    if (c.carryAmount[i] > 0) return c.carryType[i] as Resource;
    if (c.resumeTile[i] >= 0) return nodeToResource(world.map.resourceType[c.resumeTile[i]] as ResourceNode);
    if (c.resumeTarget[i] >= 0) return Resource.Food;
    return -1;
  }
  if (ot === OrderType.Move) {
    // en route to a gather target it will resume
    if (c.resumeTile[i] >= 0) return nodeToResource(world.map.resourceType[c.resumeTile[i]] as ResourceNode);
    if (c.resumeTarget[i] >= 0) return Resource.Food;
  }
  return -1;
}

// ------------------------------------------------------------ AI player -------

export function createAIPlayer(player: PlayerId, seed: number, config?: Partial<AIConfig>): AIPlayer {
  const cfg: AIConfig = {
    maxVillagers: config?.maxVillagers ?? DEFAULT_AI_CONFIG.maxVillagers,
    attackArmySize: config?.attackArmySize ?? DEFAULT_AI_CONFIG.attackArmySize,
    thinkInterval: config?.thinkInterval ?? DEFAULT_AI_CONFIG.thinkInterval,
  };
  // Private, sim-independent RNG. Seeded so each AI is reproducible yet cannot perturb world.rng.
  const rng: Rng = createRng((seed ^ (player * 0x9e3779b9)) >>> 0);

  return {
    player,
    think(world: World): Command[] {
      const interval = cfg.thinkInterval > 0 ? cfg.thinkInterval : 1;
      if (world.tick % interval !== ((player % interval) + interval) % interval) return [];
      if (world.status === MatchStatus.Ended) return [];
      const ps = world.players[player];
      if (!ps || !ps.alive) return [];

      const eco = planEconomy(world, player, cfg, rng);
      const mil = planMilitary(world, player, cfg, rng);
      const out: Command[] = [];
      for (let i = 0; i < eco.length && out.length < ECON_BUDGET; i++) out.push(eco[i]);
      for (let i = 0; i < mil.length && out.length < ECON_BUDGET + MIL_BUDGET; i++) out.push(mil[i]);
      return out.length > AI_MAX_COMMANDS ? out.slice(0, AI_MAX_COMMANDS) : out;
    },
  };
}
