// src/ai/military.ts
//
// Military planner: drives the build order (Barracks -> Feudal buildings -> Castle), age
// advancement, blacksmith/upgrade research, army production, and attack waves.
// Pure Command emitter — reads World only, mutates nothing.

import {
  Age,
  BuildingType,
  UnitType,
  TechId,
} from '../shared/enums';
import type { PlayerId, CivId } from '../shared/enums';
import type { World, PlayerState, Rng } from '../shared/world';
import type { Command } from '../shared/commands';
import type { AIConfig } from '../shared/interfaces';
import {
  BUILD_INFO,
  UNIT_INFO,
  TECH_INFO,
  MIL_QUEUE_MAX,
  TECH_AFFORD_MULT,
  PLACE_SEARCH_RADIUS,
  type Cost4,
  type PlayerScan,
  scanPlayer,
  reservableBuilders,
  hasCompleted,
  existingCount,
  handleOf,
  queueLen,
  queueHasTech,
  refTile,
  tileCenterX,
  tileCenterY,
  findPlacement,
  findNearestEnemyTC,
  findNearestEnemyEntity,
  nextAgeTech,
  uniqueUnitOf,
} from './ai';

const MIL_BUILD_CAP = 2;   // military buildings started per think
const MIL_TECH_CAP = 1;    // upgrade techs queued per think
const MIL_TRAIN_CAP = 4;   // train commands per think (round-robin across buildings)

// Military building tech tree, in the order the AI wants them.
const BUILDING_ORDER: readonly BuildingType[] = [
  BuildingType.Barracks,
  BuildingType.Blacksmith,
  BuildingType.ArcheryRange,
  BuildingType.Stable,
  BuildingType.Castle,
];

// Upgrade research priority (age techs are handled separately).
const UPGRADE_ORDER: readonly TechId[] = [
  TechId.Loom,
  TechId.ManAtArmsUpgrade,
  TechId.Forging,
  TechId.Fletching,
  TechId.ScaleMailArmor,
  TechId.ScaleBardingArmor,
  TechId.Wheelbarrow,
  TechId.IronCasting,
  TechId.ChainMailArmor,
  TechId.BodkinArrow,
];

// Buildings the AI trains military from, and how they pick a unit.
const MILITARY_BUILDINGS: readonly BuildingType[] = [
  BuildingType.Barracks,
  BuildingType.ArcheryRange,
  BuildingType.Stable,
  BuildingType.Castle,
];

function canAffordBudget(budget: number[], cost: Cost4, mul = 1): boolean {
  return (
    budget[0] >= cost[0] * mul &&
    budget[1] >= cost[1] * mul &&
    budget[2] >= cost[2] * mul &&
    budget[3] >= cost[3] * mul
  );
}

function spend(budget: number[], cost: Cost4): void {
  budget[0] -= cost[0];
  budget[1] -= cost[1];
  budget[2] -= cost[2];
  budget[3] -= cost[3];
}

function anyTCQueuedTech(world: World, scan: PlayerScan, tech: TechId): boolean {
  const tcs = scan.completeByType[BuildingType.TownCenter];
  for (let k = 0; k < tcs.length; k++) if (queueHasTech(world, tcs[k], tech)) return true;
  return false;
}

/** Age-tech prerequisites (building + prior age tech), ignoring cost. */
function ageReqsMet(ps: PlayerState, scan: PlayerScan, ageTech: TechId): boolean {
  const info = TECH_INFO[ageTech];
  if (ps.age < info.age) return false;
  if (info.reqTech !== -1 && ps.researched[info.reqTech] !== 1) return false;
  if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) return false;
  return hasCompleted(scan, info.at);
}

function techReqsMet(ps: PlayerState, scan: PlayerScan, tech: TechId): boolean {
  const info = TECH_INFO[tech];
  if (ps.researched[tech] === 1) return false;
  if (ps.age < info.age) return false;
  if (info.reqTech !== -1 && ps.researched[info.reqTech] !== 1) return false;
  if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) return false;
  return hasCompleted(scan, info.at);
}

/** The unit a given military building type should produce for `player`, or -1 if none suitable. */
function unitForBuilding(bt: BuildingType, ps: PlayerState): UnitType | -1 {
  switch (bt) {
    case BuildingType.Barracks:
      return ps.researched[TechId.ManAtArmsUpgrade] === 1 ? UnitType.ManAtArms : UnitType.Militia;
    case BuildingType.ArcheryRange:
      return UnitType.Archer;
    case BuildingType.Stable:
      return ps.age >= Age.Castle ? UnitType.Knight : UnitType.ScoutCavalry;
    case BuildingType.Castle:
      return uniqueUnitOf(ps.civ as CivId);
    default:
      return -1;
  }
}

/** Reserve the highest-index idle villager (military builds from the high end to avoid clashing with econ). */
function emitBuildHigh(
  world: World,
  player: PlayerId,
  building: BuildingType,
  nearTile: number,
  rng: Rng,
  idle: number[],
  used: Set<number>,
): Command | null {
  let builder = -1;
  for (let k = idle.length - 1; k >= 0; k--) {
    if (!used.has(idle[k])) {
      builder = idle[k];
      break;
    }
  }
  if (builder < 0) return null;
  const spot = findPlacement(world, nearTile, BUILD_INFO[building].size, rng, PLACE_SEARCH_RADIUS);
  if (!spot) return null;
  used.add(builder);
  return { type: 'build', player, units: [handleOf(world, builder)], building, tileX: spot.tileX, tileY: spot.tileY };
}

export function planMilitary(world: World, player: PlayerId, cfg: AIConfig, rng: Rng): Command[] {
  const scan = scanPlayer(world, player);
  const ps = scan.ps;
  const cmds: Command[] = [];
  const ref = refTile(world, scan);
  const refX = tileCenterX(world, ref);
  const refY = tileCenterY(world, ref);
  // Military drafts builders from the HIGH end of the pool (idle first, then active gatherers) so
  // it rarely clashes with econ, which drafts from the low end. Drafting gatherers is required:
  // once the economy is running there are no idle villagers, and military buildings (Barracks ->
  // Feudal gate, ArcheryRange/Stable/Blacksmith, Castle) would otherwise never get built.
  const idle = reservableBuilders(world, scan);
  const used = new Set<number>();
  const budget = [ps.resources[0], ps.resources[1], ps.resources[2], ps.resources[3]];

  // --- 1. Attack wave: once the army is large enough, commit the WHOLE army at the enemy. ------
  // Target the enemy Town Center ENTITY directly (an `attack` order) so the army focus-fires and
  // razes the 2400 HP TC instead of getting bogged down skirmishing defenders forever — razing a
  // TC is the only way to defeat a player, so a decisive match requires concentrated fire on it.
  // We send the full army (not just idle units) and re-issue every think so reinforcements join
  // the push and the army retargets the next-nearest TC the instant one falls. Piecemeal
  // idle-only waves against a TC's map position never resolved within the tick cap (stalemate).
  if (scan.army.length >= cfg.attackArmySize) {
    let tgt = findNearestEnemyTC(world, player, refX, refY);
    if (tgt < 0) tgt = findNearestEnemyEntity(world, player, refX, refY);
    const units = scan.army.map((i) => handleOf(world, i));
    if (tgt >= 0) {
      cmds.push({ type: 'attack', player, units, target: handleOf(world, tgt) });
    } else {
      // No enemy located yet: sweep toward the map centre to make contact.
      cmds.push({ type: 'attackMove', player, units, x: world.map.size / 2, y: world.map.size / 2 });
    }
  }

  // --- Are we saving resources for the next age? --------------------------------------------
  const ageTech = nextAgeTech(ps.age);
  const savingForAge =
    ageTech !== -1 &&
    ps.researched[ageTech] !== 1 &&
    ageReqsMet(ps, scan, ageTech) &&
    !anyTCQueuedTech(world, scan, ageTech);

  // --- 2. Age advancement (research the age tech at a Town Center). --------------------------
  if (
    ageTech !== -1 &&
    scan.tc >= 0 &&
    ps.researched[ageTech] !== 1 &&
    ageReqsMet(ps, scan, ageTech) &&
    !anyTCQueuedTech(world, scan, ageTech) &&
    canAffordBudget(budget, TECH_INFO[ageTech].cost)
  ) {
    cmds.push({ type: 'research', player, building: handleOf(world, scan.tc), tech: ageTech });
    spend(budget, TECH_INFO[ageTech].cost);
  }

  // --- 3. Building progression. --------------------------------------------------------------
  let builtCount = 0;
  for (let k = 0; k < BUILDING_ORDER.length && builtCount < MIL_BUILD_CAP; k++) {
    const bt = BUILDING_ORDER[k];
    if (bt === BuildingType.Barracks && ps.population < 8) continue; // Barracks gate: pop >= 8
    if (existingCount(scan, bt) > 0) continue;
    const info = BUILD_INFO[bt];
    if (ps.age < info.age) continue;
    if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) continue;
    if (!canAffordBudget(budget, info.cost)) continue;
    const cmd = emitBuildHigh(world, player, bt, ref, rng, idle, used);
    if (cmd) {
      cmds.push(cmd);
      spend(budget, info.cost);
      builtCount++;
    }
  }

  // --- 4. Upgrade research (only with comfortable resource surplus). -------------------------
  let techCount = 0;
  for (let k = 0; k < UPGRADE_ORDER.length && techCount < MIL_TECH_CAP; k++) {
    const tech = UPGRADE_ORDER[k];
    const info = TECH_INFO[tech];
    if (!techReqsMet(ps, scan, tech)) continue;
    if (!canAffordBudget(budget, info.cost, TECH_AFFORD_MULT)) continue;
    const bldg = scan.completeByType[info.at][0];
    if (bldg === undefined) continue;
    if (queueLen(world, bldg) >= MIL_QUEUE_MAX || queueHasTech(world, bldg, tech)) continue;
    cmds.push({ type: 'research', player, building: handleOf(world, bldg), tech });
    spend(budget, info.cost);
    techCount++;
  }

  // --- 5. Train the army (round-robin over military buildings). ------------------------------
  // Only reserve food for the next age when we are genuinely on the cusp of affording it
  // (>=60% of its food cost banked). Holding whenever food < full cost created a permanent
  // deadlock: military units cost food, so once a Blacksmith existed the AI would stop training
  // army entirely to "save" for Castle Age, never reach the 800 food (army/villager upkeep drains
  // it), never advance, never field an army, and every match would stalemate. Below the cusp we
  // keep pumping army; age-up still fires opportunistically (step 2) whenever food is sufficient.
  const ageFoodCost = ageTech !== -1 ? TECH_INFO[ageTech].cost[0] : 0;
  const holdForAge = savingForAge && budget[0] >= ageFoodCost * 0.6 && budget[0] < ageFoodCost;
  if (!holdForAge) {
    let projectedPop = ps.population;
    let trained = 0;
    for (let b = 0; b < MILITARY_BUILDINGS.length && trained < MIL_TRAIN_CAP; b++) {
      const bt = MILITARY_BUILDINGS[b];
      const buildings = scan.completeByType[bt];
      for (let j = 0; j < buildings.length && trained < MIL_TRAIN_CAP; j++) {
        const bldg = buildings[j];
        const unit = unitForBuilding(bt, ps);
        if (unit === -1) continue;
        const uinfo = UNIT_INFO[unit];
        if (ps.age < uinfo.age) continue;
        if (uinfo.tech !== -1 && ps.researched[uinfo.tech] !== 1) continue;
        if (projectedPop + uinfo.pop > ps.populationCap) continue;
        if (queueLen(world, bldg) >= MIL_QUEUE_MAX) continue;
        if (!canAffordBudget(budget, uinfo.cost)) continue;
        cmds.push({ type: 'train', player, building: handleOf(world, bldg), unit });
        spend(budget, uinfo.cost);
        projectedPop += uinfo.pop;
        trained++;
      }
    }
  }

  return cmds;
}
