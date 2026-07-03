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
export const TC_QUEUE_MAX = 1;            // stop queueing villagers at a Town Center past this depth
export const MIL_QUEUE_MAX = 3;           // stop queueing units at a military building past this depth
export const POP_BUFFER = 3;              // build a House once (cap - pop) drops to this or below (Dark)
export const POP_BUFFER_FEUDAL = 5;       // wider buffer once several buildings pop units concurrently
export const TECH_AFFORD_MULT = 1.25;     // research an upgrade only when resources exceed 1.25x its cost
export const POP_CAP_HARD = 200;          // never build houses past this (mirrors POP_CAP_MAX)
export const BUILDER_MIN_GATHERERS = 2;   // always keep at least this many villagers gathering
export const BUILDER_GATHER_KEEP = 0.6;   // keep >= this fraction of the workforce gathering; draft the rest

// Wave / defense / rebalance tuning (see design-ai.md §1.3, §3).
export const THREAT_RADIUS = 14;          // enemy military within this range of the TC is a threat
export const RAID_RADIUS = 10;            // Hard raids: hit an enemy villager within this of the army
export const STAGING_FRACTION = 0.5;      // muster new units this far from own TC toward the enemy TC
                                          // (forward, so reinforcements reach the front instead of
                                          // trickling from the base one at a time)
export const REBALANCE_DEADBAND = 2;      // only move gatherers when a resource deficit >= this
export const EVAC_RADIUS = 6;             // villagers within this of a threat evacuate to the TC

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

// Combat class of each army unit: 0 infantry, 1 archer, 2 cavalry (mirrors armorClasses from
// content/units.ts; Villager/Sheep excluded). The comp arrays don't store armor classes, so the
// AI keeps its own copy, exactly as it does for costs.
export const UNIT_CLASS: Partial<Record<UnitType, 0 | 1 | 2>> = {
  [UnitType.Militia]: 0,
  [UnitType.ManAtArms]: 0,
  [UnitType.Spearman]: 0,
  [UnitType.ThrowingAxeman]: 0,
  [UnitType.Archer]: 1,
  [UnitType.Longbowman]: 1,
  [UnitType.ScoutCavalry]: 2,
  [UnitType.Knight]: 2,
  [UnitType.Mangudai]: 2,
};

// ------------------------------------------------------- difficulty presets --

export interface DifficultyTuning {
  maxVillagers: number;            // preset default villager cap
  attackArmySize: number;          // preset default commit size
  thinkInterval: number;           // preset default think cadence
  darkVillagers: number;           // villagers that open the Dark-Age food bank
  feudalVillagers: number;         // villagers that open the Feudal->Castle bank
  castleVillagers: number;         // target villagers in Castle age
  waveSize: [number, number, number, number]; // commit size by age [Dark, Feudal, Castle, Imperial]
  darkMilitia: number;             // max Dark-Age military before the bank takes over
  retreatFraction: number;         // retreat when army drops below this * waveSize (0 = never)
  counters: boolean;               // counter-aware composition (off => default mix)
  raids: boolean;                  // Hard-only opportunistic villager raids en route
  buildsCastle: boolean;           // Hard-only: 2nd TC / Castle building / Imperial ambitions
  rebalancePerThink: number;       // gatherers actively moved between resources per think
  maxFarms: [number, number, number]; // farm cap by age [Dark, Feudal, Castle+]
  upgradeMult: number;             // afford multiple gate for blacksmith/eco upgrades
  lateGameTick: number;            // past this tick: halve waveSize, disable retreat (anti-stalemate)
}

export const DIFFICULTY_TUNING: Record<'easy' | 'medium' | 'hard', DifficultyTuning> = {
  easy: {
    maxVillagers: 14, attackArmySize: 8, thinkInterval: 20,
    darkVillagers: 10, feudalVillagers: 14, castleVillagers: 16,
    waveSize: [0, 8, 10, 10], darkMilitia: 1, retreatFraction: 0,
    counters: false, raids: false, buildsCastle: false,
    rebalancePerThink: 1, maxFarms: [6, 8, 10], upgradeMult: 2.0, lateGameTick: 24000,
  },
  medium: {
    maxVillagers: 18, attackArmySize: 12, thinkInterval: 10,
    darkVillagers: 13, feudalVillagers: 18, castleVillagers: 22,
    waveSize: [0, 10, 16, 16], darkMilitia: 5, retreatFraction: 0.4,
    counters: true, raids: false, buildsCastle: false,
    rebalancePerThink: 2, maxFarms: [8, 12, 16], upgradeMult: 1.25, lateGameTick: 12000,
  },
  hard: {
    maxVillagers: 24, attackArmySize: 16, thinkInterval: 10,
    darkVillagers: 16, feudalVillagers: 22, castleVillagers: 28,
    waveSize: [0, 12, 20, 20], darkMilitia: 6, retreatFraction: 0.4,
    counters: true, raids: true, buildsCastle: true,
    rebalancePerThink: 3, maxFarms: [8, 12, 16], upgradeMult: 1.25, lateGameTick: 14000,
  },
};

// ------------------------------------------------------------ phase machine --

export const Phase = { DarkOpen: 0, DarkBank: 1, FeudalEco: 2, FeudalBank: 3, Castle: 4 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

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

/** True if the mutable FWGS wallet covers `cost * mul`. */
export function canAffordBudget(budget: number[], cost: Cost4, mul = 1): boolean {
  return (
    budget[0] >= cost[0] * mul &&
    budget[1] >= cost[1] * mul &&
    budget[2] >= cost[2] * mul &&
    budget[3] >= cost[3] * mul
  );
}

/** Deduct `cost` from the mutable wallet (may go negative — callers gate with canAffordBudget/Free). */
export function spend(budget: number[], cost: Cost4): void {
  budget[0] -= cost[0];
  budget[1] -= cost[1];
  budget[2] -= cost[2];
  budget[3] -= cost[3];
}

/**
 * Non-age spending may not touch the reserve (the "bank" earmarked for the next age tech). This
 * single gate is what guarantees the AI banks 500/800 food: once a *_BANK phase is active every
 * income accumulates monotonically toward the reserve — villagers, military and upgrades can only
 * spend the surplus above it. The age tech itself checks the raw budget (the bank exists FOR it).
 */
export function canAffordFree(ctx: AIContext, cost: Cost4, mul = 1): boolean {
  const b = ctx.budget;
  const r = ctx.reserve;
  return (
    b[0] - r[0] >= cost[0] * mul &&
    b[1] - r[1] >= cost[1] * mul &&
    b[2] - r[2] >= cost[2] * mul &&
    b[3] - r[3] >= cost[3] * mul
  );
}

/** True if any completed Town Center is queueing `tech`. */
export function anyTCQueuedTech(world: World, scan: PlayerScan, tech: TechId): boolean {
  const tcs = scan.completeByType[BuildingType.TownCenter];
  for (let k = 0; k < tcs.length; k++) if (queueHasTech(world, tcs[k], tech)) return true;
  return false;
}

/** Age-tech prerequisites (building + prior-age tech), ignoring cost. */
export function ageReqsMet(ps: PlayerState, scan: PlayerScan, ageTech: TechId): boolean {
  const info = TECH_INFO[ageTech];
  if (ps.age < info.age) return false;
  if (info.reqTech !== -1 && ps.researched[info.reqTech] !== 1) return false;
  if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) return false;
  return hasCompleted(scan, info.at);
}

/** Upgrade-tech prerequisites (not already researched, age, prior tech, building), ignoring cost. */
export function techReqsMet(ps: PlayerState, scan: PlayerScan, tech: TechId): boolean {
  const info = TECH_INFO[tech];
  if (ps.researched[tech] === 1) return false;
  if (ps.age < info.age) return false;
  if (info.reqTech !== -1 && ps.researched[info.reqTech] !== 1) return false;
  if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) return false;
  return hasCompleted(scan, info.at);
}

/** Index of the largest positive deficit (target - current); -1 if none is under target. */
export function pickByDeficit(targets: number[], current: number[]): number {
  let best = -1;
  let bestGap = 0;
  for (let r = 0; r < targets.length; r++) {
    const gap = targets[r] - current[r];
    if (gap > bestGap) {
      bestGap = gap;
      best = r;
    }
  }
  return best;
}

/** Largest-remainder apportionment of `total` integer slots over `weights` (sum need not be 1). */
export function largestRemainder(weights: number[], total: number): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  if (total <= 0) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i] > 0 ? weights[i] : 0;
  if (sum <= 0) return out;
  const rema: { i: number; r: number }[] = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const exact = ((weights[i] > 0 ? weights[i] : 0) / sum) * total;
    const fl = Math.floor(exact);
    out[i] = fl;
    assigned += fl;
    rema.push({ i, r: exact - fl });
  }
  let left = total - assigned;
  // Distribute leftover to the largest fractional parts; tie -> lowest index (stable, deterministic).
  rema.sort((a, b) => (b.r !== a.r ? b.r - a.r : a.i - b.i));
  for (let k = 0; k < rema.length && left > 0; k++, left--) out[rema[k].i]++;
  return out;
}

/** Count of Forage tiles with amount > 0 within Chebyshev radius `radius` of `ref` (bounded ring scan). */
export function forageTilesLeft(world: World, ref: number, radius: number): number {
  const map = world.map;
  const size = map.size;
  const fx = tileXOf(size, ref);
  const fy = tileYOf(size, ref);
  const rt = map.resourceType;
  const ra = map.resourceAmount;
  let count = 0;
  const y0 = Math.max(0, fy - radius);
  const y1 = Math.min(size - 1, fy + radius);
  const x0 = Math.max(0, fx - radius);
  const x1 = Math.min(size - 1, fx + radius);
  for (let y = y0; y <= y1; y++) {
    const row = y * size;
    for (let x = x0; x <= x1; x++) {
      const t = row + x;
      if (rt[t] === ResourceNode.Forage && ra[t] > 0) count++;
    }
  }
  return count;
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

/** Nearest enemy MILITARY unit (not villager/sheep, not building) within `maxR` of (px,py); index or -1. */
export function findNearestEnemyMilitary(world: World, player: PlayerId, px: number, py: number, maxR: number): number {
  const em = world.em;
  const c = world.comp;
  let best = -1;
  let bestD = maxR * maxR;
  for (let i = 0; i < c.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    if (c.kind[i] !== EntityKind.Unit) continue;
    const owner = c.owner[i];
    if (owner === player || owner === GAIA) continue;
    const st = c.subtype[i];
    if (st === UnitType.Villager || st === UnitType.Sheep) continue;
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

// ------------------------------------------------------------ AI context -----

/** Enemy picture gathered in the SAME O(capacity) pass as the own-player scan. */
export interface EnemyIntel {
  armyByClass: [number, number, number]; // [infantry, archer, cavalry] enemy military counts
  armyCount: number;                     // total enemy military
  nearestTC: number;                     // enemy TC entity index nearest own ref, or -1
  nearestVillagerToArmy: number;         // enemy villager index nearest own army centroid, or -1
  threats: number[];                     // enemy military indices within THREAT_RADIUS of own ref
  nearestThreat: number;                 // nearest threat index, or -1
}

/** Private, per-AI-instance mutable state. Evolves ONLY through the deterministic tick sequence. */
export interface AIMemory {
  attacking: boolean;      // committed to a wave this think (recomputed each tick: armyCount >= wave)
  scoutWaypoint: number;   // index into the scout patrol ring
  scoutHandle: number;     // handle of the scouting ScoutCavalry, or -1
  rallyTile: number;       // last staging tile we set rallies for, or -1
  focusTarget: number;     // handle of the enemy TC the army is razing (sticky), or -1
}

export interface AIContext {
  world: World;
  player: PlayerId;
  cfg: AIConfig;
  tuning: DifficultyTuning;
  explicitArmy: boolean;   // caller passed cfg.attackArmySize -> waveSize honors it verbatim
  rng: Rng;
  scan: PlayerScan;        // ONE scan per think (was two)
  intel: EnemyIntel;       // gathered in the SAME pass
  ref: number;             // home tile
  refX: number;
  refY: number;
  budget: [number, number, number, number];  // mutable FWGS wallet, shared by BOTH planners
  reserve: [number, number, number, number];  // earmarked for the next age tech (the "bank")
  banking: boolean;        // a *_BANK phase is active
  phase: Phase;
  builders: number[];      // builder pool (idle first, then draftable gatherers), shared
  used: Set<number>;       // builder reservations shared across planners
  mem: AIMemory;
  armyCx: number;          // own army centroid (world coords)
  armyCy: number;
  armyByClass: [number, number, number];
  scout: number;           // own scouting ScoutCavalry entity index (Dark/Feudal), or -1
  armyCount: number;       // own army excluding the active scout
  sheepNearBase: number;   // gaia sheep (with food) within 20 tiles of ref (natural-food model)
}

/** Stateless phase from age + villager count + building existence (save/load-proof). */
function derivePhase(world: World, scan: PlayerScan, tuning: DifficultyTuning): Phase {
  const ps = scan.ps;
  const villagers = scan.villagers.length;
  if (ps.age === Age.Dark) {
    const barracks = existingCount(scan, BuildingType.Barracks) > 0;
    const feudalDone =
      ps.researched[TechId.FeudalAge] === 1 || anyTCQueuedTech(world, scan, TechId.FeudalAge);
    if (villagers >= tuning.darkVillagers && barracks && !feudalDone) return Phase.DarkBank;
    return Phase.DarkOpen;
  }
  if (ps.age === Age.Feudal) {
    const blacksmith = hasCompleted(scan, BuildingType.Blacksmith);
    const castleDone =
      ps.researched[TechId.CastleAge] === 1 || anyTCQueuedTech(world, scan, TechId.CastleAge);
    if (villagers >= tuning.feudalVillagers && blacksmith && !castleDone) return Phase.FeudalBank;
    return Phase.FeudalEco;
  }
  return Phase.Castle; // Castle or Imperial
}

/** One O(capacity) pass -> PlayerScan + EnemyIntel + own aggregates, then the phase/bank + wallet. */
export function buildContext(
  world: World,
  player: PlayerId,
  cfg: AIConfig,
  tuning: DifficultyTuning,
  explicitArmy: boolean,
  rng: Rng,
  mem: AIMemory,
): AIContext {
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
  let armySumX = 0;
  let armySumY = 0;
  let armyN = 0;
  const armyByClass: [number, number, number] = [0, 0, 0];
  let scout = -1;
  const enemyTCs: number[] = [];
  const enemyMil: number[] = [];
  const enemyVil: number[] = [];
  const enemyByClass: [number, number, number] = [0, 0, 0];
  let enemyCount = 0;
  const sheep: number[] = [];

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    const owner = comp.owner[i];
    const kind = comp.kind[i];
    const st = comp.subtype[i];
    if (owner === player) {
      if (kind === EntityKind.Unit) {
        if (st === UnitType.Villager) {
          villagers.push(i);
          if (comp.orderType[i] === OrderType.Idle) idleVillagers.push(i);
        } else if (st !== UnitType.Sheep) {
          army.push(i);
          if (comp.orderType[i] === OrderType.Idle) idleArmy.push(i);
          const cls = UNIT_CLASS[st as UnitType];
          if (cls !== undefined) armyByClass[cls]++;
          armySumX += comp.posX[i];
          armySumY += comp.posY[i];
          armyN++;
          if (st === UnitType.ScoutCavalry && scout === -1) scout = i;
        }
      } else if (kind === EntityKind.Building) {
        if (st >= 0 && st < BUILDING_TYPE_COUNT) {
          if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) {
            underConstruction[st].push(i);
          } else {
            completeByType[st].push(i);
            if (st === BuildingType.TownCenter && tc === -1) tc = i;
          }
        }
      }
    } else if (owner === GAIA) {
      if (kind === EntityKind.Unit && st === UnitType.Sheep && comp.storedResource[i] > 0) sheep.push(i);
    } else {
      // Enemy (non-gaia, not us).
      if (kind === EntityKind.Building) {
        if (st === BuildingType.TownCenter) enemyTCs.push(i);
      } else if (kind === EntityKind.Unit) {
        if (st === UnitType.Villager) {
          enemyVil.push(i);
        } else if (st !== UnitType.Sheep) {
          const cls = UNIT_CLASS[st as UnitType];
          if (cls !== undefined) enemyByClass[cls]++;
          enemyCount++;
          enemyMil.push(i);
        }
      }
    }
  }

  const scan: PlayerScan = {
    ps: world.players[player],
    villagers,
    idleVillagers,
    army,
    idleArmy,
    completeByType,
    underConstruction,
    tc,
  };
  const ps = scan.ps;
  const ref = refTile(world, scan);
  const refX = tileCenterX(world, ref);
  const refY = tileCenterY(world, ref);
  const armyCx = armyN > 0 ? armySumX / armyN : refX;
  const armyCy = armyN > 0 ? armySumY / armyN : refY;

  // Nearest enemy TC to ref (tie -> lowest index).
  let nearestTC = -1;
  let bestTC = Infinity;
  for (let k = 0; k < enemyTCs.length; k++) {
    const i = enemyTCs[k];
    const d = dist2(refX, refY, comp.posX[i], comp.posY[i]);
    if (d < bestTC) {
      bestTC = d;
      nearestTC = i;
    }
  }
  // Threats: enemy military within THREAT_RADIUS of ref.
  const threats: number[] = [];
  let nearestThreat = -1;
  let bestThreat = Infinity;
  const tr2 = THREAT_RADIUS * THREAT_RADIUS;
  for (let k = 0; k < enemyMil.length; k++) {
    const i = enemyMil[k];
    const d = dist2(refX, refY, comp.posX[i], comp.posY[i]);
    if (d <= tr2) {
      threats.push(i);
      if (d < bestThreat) {
        bestThreat = d;
        nearestThreat = i;
      }
    }
  }
  // Nearest enemy villager to own army centroid (raid target).
  let nearestVil = -1;
  let bestVil = Infinity;
  for (let k = 0; k < enemyVil.length; k++) {
    const i = enemyVil[k];
    const d = dist2(armyCx, armyCy, comp.posX[i], comp.posY[i]);
    if (d < bestVil) {
      bestVil = d;
      nearestVil = i;
    }
  }

  const intel: EnemyIntel = {
    armyByClass: enemyByClass,
    armyCount: enemyCount,
    nearestTC,
    nearestVillagerToArmy: nearestVil,
    threats,
    nearestThreat,
  };

  const phase = derivePhase(world, scan, tuning);
  const reserve: [number, number, number, number] = [0, 0, 0, 0];
  if (phase === Phase.DarkBank) {
    reserve[0] = 500;
  } else if (phase === Phase.FeudalBank) {
    reserve[0] = 800;
    reserve[2] = 200;
  } else if (
    phase === Phase.Castle &&
    tuning.buildsCastle &&
    hasCompleted(scan, BuildingType.Castle) &&
    ps.age === Age.Castle &&
    ps.researched[TechId.ImperialAge] !== 1 &&
    !anyTCQueuedTech(world, scan, TechId.ImperialAge)
  ) {
    // Hard-only Imperial ambition: earmark the tech so eco/military can only spend the surplus.
    reserve[0] = 1000;
    reserve[2] = 800;
  }
  let banking = phase === Phase.DarkBank || phase === Phase.FeudalBank;

  // Late-game anti-stalemate valve: past lateGameTick stop teching/banking entirely and pour every
  // resource into the army. Combined with the halved waveSize + disabled retreat/defense-preemption
  // in the military planner, this guarantees the merge gate resolves to a decisive winner.
  if (world.tick > tuning.lateGameTick) {
    reserve[0] = 0;
    reserve[1] = 0;
    reserve[2] = 0;
    reserve[3] = 0;
    banking = false;
  }

  const budget: [number, number, number, number] = [
    ps.resources[0],
    ps.resources[1],
    ps.resources[2],
    ps.resources[3],
  ];
  const builders = reservableBuilders(world, scan);
  const used = new Set<number>();

  // The scout is set aside for patrol (spectacle + fog reveal) only in Dark/Feudal.
  const scoutIdx = ps.age < Age.Castle ? scout : -1;
  const armyCount = army.length - (scoutIdx >= 0 ? 1 : 0);

  // Natural-food model: sheep (with food remaining) within 20 tiles of the base.
  let sheepNearBase = 0;
  const r20 = 20 * 20;
  for (let k = 0; k < sheep.length; k++) {
    const i = sheep[k];
    if (dist2(refX, refY, comp.posX[i], comp.posY[i]) <= r20) sheepNearBase++;
  }

  return {
    world,
    player,
    cfg,
    tuning,
    explicitArmy,
    rng,
    scan,
    intel,
    ref,
    refX,
    refY,
    budget,
    reserve,
    banking,
    phase,
    builders,
    used,
    mem,
    armyCx,
    armyCy,
    armyByClass,
    scout: scoutIdx,
    armyCount,
    sheepNearBase,
  };
}

// ---- Strategy-first commands (emitted BEFORE the planners so the 8-cap never truncates them) ----

/** Research the next-age tech the instant reqs are met AND the raw budget covers the full cost. */
function ageUp(ctx: AIContext): Command[] {
  const { world, player, scan } = ctx;
  const ps = scan.ps;
  const ageTech = nextAgeTech(ps.age);
  if (ageTech === -1 || scan.tc < 0) return [];
  if (ps.researched[ageTech] === 1) return [];
  if (!ageReqsMet(ps, scan, ageTech)) return [];
  if (anyTCQueuedTech(world, scan, ageTech)) return [];
  const cost = TECH_INFO[ageTech].cost;
  if (!canAffordBudget(ctx.budget, cost)) return [];
  spend(ctx.budget, cost);
  return [{ type: 'research', player, building: handleOf(world, scan.tc), tech: ageTech }];
}

/** While banking, use the otherwise-idle TC to research Loom (gold-only; never touches the food bank). */
function bankLoom(ctx: AIContext): Command[] {
  if (!ctx.banking) return [];
  const { world, player, scan } = ctx;
  const ps = scan.ps;
  if (scan.tc < 0) return [];
  if (ps.researched[TechId.Loom] === 1) return [];
  if (queueLen(world, scan.tc) > 0) return [];
  if (anyTCQueuedTech(world, scan, TechId.Loom)) return [];
  const cost = TECH_INFO[TechId.Loom].cost;
  if (!canAffordFree(ctx, cost)) return [];
  spend(ctx.budget, cost);
  return [{ type: 'research', player, building: handleOf(world, scan.tc), tech: TechId.Loom }];
}

// ------------------------------------------------------------ AI player -------

export function createAIPlayer(player: PlayerId, seed: number, config?: Partial<AIConfig>): AIPlayer {
  const difficulty = config?.difficulty ?? 'medium';
  const tuning = DIFFICULTY_TUNING[difficulty];
  // Explicit maxVillagers/attackArmySize/thinkInterval ALWAYS override the preset (full back-compat).
  const cfg: AIConfig = {
    maxVillagers: config?.maxVillagers ?? tuning.maxVillagers,
    attackArmySize: config?.attackArmySize ?? tuning.attackArmySize,
    thinkInterval: config?.thinkInterval ?? tuning.thinkInterval,
    difficulty,
  };
  const explicitArmy = config?.attackArmySize !== undefined;
  // Private, sim-independent RNG. Seeded so each AI is reproducible yet cannot perturb world.rng.
  const rng: Rng = createRng((seed ^ (player * 0x9e3779b9)) >>> 0);
  // Per-instance mutable memory (evolves only through the deterministic tick sequence).
  const mem: AIMemory = {
    attacking: false,
    scoutWaypoint: 0,
    scoutHandle: -1,
    rallyTile: -1,
    focusTarget: -1,
  };

  return {
    player,
    think(world: World): Command[] {
      const interval = cfg.thinkInterval > 0 ? cfg.thinkInterval : 1;
      if (world.tick % interval !== ((player % interval) + interval) % interval) return [];
      if (world.status === MatchStatus.Ended) return [];
      const ps = world.players[player];
      if (!ps || !ps.alive) return [];

      const ctx = buildContext(world, player, cfg, tuning, explicitArmy, rng, mem);

      // Strategy first: age-up + Loom emitted before the planners so the 8-cap can never drop them.
      const strat: Command[] = [];
      for (const c of ageUp(ctx)) strat.push(c);
      for (const c of bankLoom(ctx)) strat.push(c);

      const eco = planEconomy(ctx);
      const mil = planMilitary(ctx);

      const out: Command[] = [];
      for (let i = 0; i < strat.length; i++) out.push(strat[i]);
      const ecoLimit = strat.length + ECON_BUDGET;
      for (let i = 0; i < eco.length && out.length < ecoLimit; i++) out.push(eco[i]);
      const milLimit = strat.length + ECON_BUDGET + MIL_BUDGET;
      for (let i = 0; i < mil.length && out.length < milLimit; i++) out.push(mil[i]);
      return out.length > AI_MAX_COMMANDS ? out.slice(0, AI_MAX_COMMANDS) : out;
    },
  };
}
