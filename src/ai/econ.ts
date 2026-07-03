// src/ai/econ.ts
//
// Economy planner: keep villagers productive, grow the villager count, stay ahead of the
// population cap, place drop-off camps / anticipatory farms, and rebalance gatherers to the
// town's ACTUAL per-phase needs. Pure Command emitter — reads World only, mutates nothing (it
// only mutates the shared AIContext wallet/reservation set, which is per-instance scratch state).

import {
  Age,
  BuildingType,
  UnitType,
  Resource,
  ResourceNode,
  TechId,
} from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { World } from '../shared/world';
import type { Command } from '../shared/commands';
import {
  BUILD_INFO,
  UNIT_INFO,
  TECH_INFO,
  PLACE_SEARCH_RADIUS,
  RESOURCE_SEARCH_RADIUS,
  CAMP_DISTANCE_THRESHOLD,
  TC_QUEUE_MAX,
  POP_BUFFER,
  POP_BUFFER_FEUDAL,
  POP_CAP_HARD,
  REBALANCE_DEADBAND,
  Phase,
  canAffordFree,
  spend,
  handleOf,
  queueLen,
  queueHasTech,
  tileCenterX,
  tileCenterY,
  findNearestNode,
  findNearestSheep,
  findNearestOwnFarm,
  findPlacement,
  minDistToBuildings,
  villagerResource,
  largestRemainder,
  pickByDeficit,
  forageTilesLeft,
  type AIContext,
  type PlayerScan,
} from './ai';

interface GatherTarget {
  kind: 'tile' | 'entity';
  id: number; // tile index (tile) or entity handle (entity)
}

/** Per-phase target split of gatherers across [Food, Wood, Gold, Stone] (weights, sum need not be 1). */
function gatherWeights(ctx: AIContext): [number, number, number, number] {
  switch (ctx.phase) {
    case Phase.DarkOpen:
      return [0.58, 0.38, 0.04, 0];
    case Phase.DarkBank:
      return [0.68, 0.26, 0.06, 0];
    case Phase.FeudalEco:
      return [0.45, 0.35, 0.2, 0];
    case Phase.FeudalBank:
      return [0.6, 0.22, 0.18, 0];
    case Phase.Castle:
    default:
      return ctx.tuning.buildsCastle ? [0.42, 0.28, 0.18, 0.12] : [0.45, 0.3, 0.2, 0.05];
  }
}

/** Food fallback chain: sheep first (fastest, sit at the drop-off), then forage, then a standing farm. */
function resolveGatherTargets(world: World, player: PlayerId, ref: number): (GatherTarget | null)[] {
  const refX = tileCenterX(world, ref);
  const refY = tileCenterY(world, ref);
  const targets: (GatherTarget | null)[] = [null, null, null, null];

  const sheep = findNearestSheep(world, refX, refY);
  if (sheep >= 0) {
    targets[Resource.Food] = { kind: 'entity', id: sheep };
  } else {
    const forage = findNearestNode(world, ref, ResourceNode.Forage, RESOURCE_SEARCH_RADIUS);
    if (forage >= 0) {
      targets[Resource.Food] = { kind: 'tile', id: forage };
    } else {
      const farm = findNearestOwnFarm(world, player, refX, refY);
      if (farm >= 0) targets[Resource.Food] = { kind: 'entity', id: farm };
    }
  }

  const tree = findNearestNode(world, ref, ResourceNode.Tree, RESOURCE_SEARCH_RADIUS);
  if (tree >= 0) targets[Resource.Wood] = { kind: 'tile', id: tree };

  const gold = findNearestNode(world, ref, ResourceNode.GoldMine, RESOURCE_SEARCH_RADIUS);
  if (gold >= 0) targets[Resource.Gold] = { kind: 'tile', id: gold };

  const stone = findNearestNode(world, ref, ResourceNode.StoneMine, RESOURCE_SEARCH_RADIUS);
  if (stone >= 0) targets[Resource.Stone] = { kind: 'tile', id: stone };

  return targets;
}

function emitGather(world: World, player: PlayerId, group: number[], t: GatherTarget): Command {
  const units = group.map((i) => handleOf(world, i));
  return t.kind === 'tile'
    ? { type: 'gatherTile', player, units, tile: t.id }
    : { type: 'gatherEntity', player, units, target: t.id };
}

function buildingRefTile(world: World, index: number): number {
  const size = world.map.size;
  const c = world.comp;
  const sx = c.sizeX[index] || 1;
  const sy = c.sizeY[index] || 1;
  const tx = Math.max(0, Math.min(size - 1, Math.round(c.posX[index] - sx / 2)));
  const ty = Math.max(0, Math.min(size - 1, Math.round(c.posY[index] - sy / 2)));
  return ty * size + tx;
}

/** Reserve a builder (low end of the shared pool) + find placement near `nearTile`; emit or null. */
function emitBuild(ctx: AIContext, building: BuildingType, nearTile: number): Command | null {
  const { world, player, builders, used, rng } = ctx;
  let builder = -1;
  for (let k = 0; k < builders.length; k++) {
    if (!used.has(builders[k])) {
      builder = builders[k];
      break;
    }
  }
  if (builder < 0) return null;
  const spot = findPlacement(world, nearTile, BUILD_INFO[building].size, rng, PLACE_SEARCH_RADIUS);
  if (!spot) return null;
  used.add(builder);
  spend(ctx.budget, BUILD_INFO[building].cost);
  return { type: 'build', player, units: [handleOf(world, builder)], building, tileX: spot.tileX, tileY: spot.tileY };
}

/** min(cfg.maxVillagers, per-phase villager target). */
function villagerTarget(ctx: AIContext): number {
  const t = ctx.tuning;
  const age = ctx.scan.ps.age;
  const byAge = age === Age.Dark ? t.darkVillagers : age === Age.Feudal ? t.feudalVillagers : t.castleVillagers;
  return Math.min(ctx.cfg.maxVillagers, byAge);
}

/** Count villager items currently queued across all completed Town Centers. */
function queuedVillagers(world: World, scan: PlayerScan): number {
  let n = 0;
  const tcs = scan.completeByType[BuildingType.TownCenter];
  for (let k = 0; k < tcs.length; k++) {
    const q = world.comp.queue[tcs[k]];
    if (!q) continue;
    for (let j = 0; j < q.length; j++) {
      const it = q[j];
      if (it.kind === 'unit' && it.unit === UnitType.Villager) n++;
    }
  }
  return n;
}

/**
 * Choose at most ONE resource building this think: Mill (farm prerequisite / far forage) ->
 * LumberCamp -> MiningCamp -> anticipatory Farm.
 */
function planResourceBuilding(ctx: AIContext): Command | null {
  const { world, player, scan, ref } = ctx;
  const woodDropoffs = scan.completeByType[BuildingType.TownCenter].concat(scan.completeByType[BuildingType.LumberCamp]);
  const miningDropoffs = scan.completeByType[BuildingType.TownCenter].concat(scan.completeByType[BuildingType.MiningCamp]);

  const forage = findNearestNode(world, ref, ResourceNode.Forage, RESOURCE_SEARCH_RADIUS);
  const millExists =
    scan.completeByType[BuildingType.Mill].length + scan.underConstruction[BuildingType.Mill].length > 0;
  const barracksExists =
    scan.completeByType[BuildingType.Barracks].length + scan.underConstruction[BuildingType.Barracks].length > 0;

  // 1. Mill — the farm prerequisite. Build it once the Barracks (the Feudal gate) is placed so it
  //    never steals the starting wood from the Barracks; place it AT the forage cluster (drop-off
  //    savings + farm anchor). Also build it if forage is already gone but we still need farms.
  if (!millExists && canAffordFree(ctx, BUILD_INFO[BuildingType.Mill].cost) && (barracksExists || forage < 0)) {
    const near = forage >= 0 ? forage : ref;
    const cmd = emitBuild(ctx, BuildingType.Mill, near);
    if (cmd) return cmd;
  }

  // 2. LumberCamp near a distant forest (forests recede as they are cut).
  if (
    scan.completeByType[BuildingType.LumberCamp].length + scan.underConstruction[BuildingType.LumberCamp].length === 0 &&
    canAffordFree(ctx, BUILD_INFO[BuildingType.LumberCamp].cost)
  ) {
    const tree = findNearestNode(world, ref, ResourceNode.Tree, RESOURCE_SEARCH_RADIUS);
    if (
      tree >= 0 &&
      minDistToBuildings(world, tileCenterX(world, tree), tileCenterY(world, tree), woodDropoffs) > CAMP_DISTANCE_THRESHOLD
    ) {
      const cmd = emitBuild(ctx, BuildingType.LumberCamp, tree);
      if (cmd) return cmd;
    }
  }

  // 3. MiningCamp near a distant gold/stone deposit (worth it once we actually mine — Feudal+, or a
  //    Dark bank that has spare wood and wants Loom/militia gold).
  const wantMining = ctx.scan.ps.age >= Age.Feudal || ctx.phase === Phase.DarkBank;
  if (
    wantMining &&
    scan.completeByType[BuildingType.MiningCamp].length + scan.underConstruction[BuildingType.MiningCamp].length === 0 &&
    canAffordFree(ctx, BUILD_INFO[BuildingType.MiningCamp].cost)
  ) {
    const gold = findNearestNode(world, ref, ResourceNode.GoldMine, RESOURCE_SEARCH_RADIUS);
    const stone = findNearestNode(world, ref, ResourceNode.StoneMine, RESOURCE_SEARCH_RADIUS);
    let node = -1;
    if (gold >= 0 && minDistToBuildings(world, tileCenterX(world, gold), tileCenterY(world, gold), miningDropoffs) > CAMP_DISTANCE_THRESHOLD) {
      node = gold;
    } else if (stone >= 0 && minDistToBuildings(world, tileCenterX(world, stone), tileCenterY(world, stone), miningDropoffs) > CAMP_DISTANCE_THRESHOLD) {
      node = stone;
    }
    if (node >= 0) {
      const cmd = emitBuild(ctx, BuildingType.MiningCamp, node);
      if (cmd) return cmd;
    }
  }

  // 4. Anticipatory farms — begin while forage is running OUT, not after it is gone. The natural
  //    food (remaining forage tiles + nearby sheep) covers so many food workers; farms make up the
  //    rest, up to the per-age cap. Each depleted forage tile raises the target by one.
  const age = ctx.scan.ps.age;
  const farmIdx = age < Age.Feudal ? 0 : age < Age.Castle ? 1 : 2;
  const maxFarms = ctx.tuning.maxFarms[farmIdx];
  if (maxFarms > 0 && millExists && canAffordFree(ctx, BUILD_INFO[BuildingType.Farm].cost)) {
    const weights = gatherWeights(ctx);
    const workers = scan.villagers.length || 1;
    const foodTarget = Math.round(weights[Resource.Food] * workers);
    const natural = Math.min(forageTilesLeft(world, ref, 20) + ctx.sheepNearBase, foodTarget);
    const farmTarget = Math.max(0, Math.min(foodTarget - natural, maxFarms));
    const farmCount =
      scan.completeByType[BuildingType.Farm].length + scan.underConstruction[BuildingType.Farm].length;
    if (farmCount < farmTarget) {
      const near =
        scan.completeByType[BuildingType.Mill].length > 0
          ? buildingRefTile(world, scan.completeByType[BuildingType.Mill][0])
          : ref;
      const cmd = emitBuild(ctx, BuildingType.Farm, near);
      if (cmd) return cmd;
    }
  }

  return null;
}

/**
 * Need-driven gather allocator: assign idle villagers to the largest deficit, then ACTIVELY move up
 * to rebalancePerThink gatherers from the most over-staffed resource to the most under-staffed one
 * (deadband hysteresis avoids churn), batched into ONE command.
 */
function planGather(ctx: AIContext): Command[] {
  const { world, player, scan, ref } = ctx;
  const cmds: Command[] = [];
  const targetsSrc = resolveGatherTargets(world, player, ref);

  // Effective weights: zero-out resources with no reachable node (gold/stone gating), then
  // largest-remainder over the workforce.
  const weights = gatherWeights(ctx);
  const age = scan.ps.age;
  const goldEnabled = targetsSrc[Resource.Gold] !== null && (age >= Age.Feudal || ctx.phase === Phase.DarkBank);
  const stoneWanted = ctx.tuning.buildsCastle && age >= Age.Castle && targetsSrc[Resource.Stone] !== null;
  if (targetsSrc[Resource.Food] === null) weights[Resource.Food] = 0;
  if (targetsSrc[Resource.Wood] === null) weights[Resource.Wood] = 0;
  if (!goldEnabled) weights[Resource.Gold] = 0;
  if (!stoneWanted) weights[Resource.Stone] = 0;

  const workers = scan.villagers.length;
  const targets = largestRemainder(weights, workers); // integer targets (for rebalance)
  // Fractional desired counts give the idle-assignment finer granularity than integer targets
  // (so a 2-worker split of a [food, wood] town still puts one on each rather than both on food).
  let sumW = 0;
  for (let r = 0; r < 4; r++) sumW += weights[r] > 0 ? weights[r] : 0;
  const desiredF: number[] = [0, 0, 0, 0];
  if (sumW > 0) for (let r = 0; r < 4; r++) desiredF[r] = ((weights[r] > 0 ? weights[r] : 0) / sumW) * workers;

  // Current allocation by resource.
  const current: number[] = [0, 0, 0, 0];
  const workingByRes: number[][] = [[], [], [], []];
  for (let k = 0; k < scan.villagers.length; k++) {
    const vi = scan.villagers[k];
    if (ctx.used.has(vi)) continue; // reserved as a builder this think
    const r = villagerResource(world, vi);
    if (r >= 0) {
      current[r]++;
      workingByRes[r].push(vi);
    }
  }

  // 1. Assign idle (non-reserved) villagers to the biggest deficit.
  const groups: number[][] = [[], [], [], []];
  for (let k = 0; k < scan.idleVillagers.length; k++) {
    const vi = scan.idleVillagers[k];
    if (ctx.used.has(vi)) continue;
    let r = pickByDeficit(desiredF, current);
    if (r < 0 || targetsSrc[r] === null) {
      // No deficit / unreachable: fall back to wood then food.
      if (targetsSrc[Resource.Wood] !== null) r = Resource.Wood;
      else if (targetsSrc[Resource.Food] !== null) r = Resource.Food;
      else continue;
    }
    groups[r].push(vi);
    current[r]++;
  }
  for (let r = 0; r < 4; r++) {
    const t = targetsSrc[r];
    if (groups[r].length > 0 && t !== null) cmds.push(emitGather(world, player, groups[r], t));
  }

  // 2. Active rebalance: move gatherers from the most over-staffed to the most under-staffed
  //    resource, but only past the deadband (hysteresis). One batched command.
  let over = -1;
  let overSurplus = REBALANCE_DEADBAND - 1;
  let under = -1;
  let underDeficit = REBALANCE_DEADBAND - 1;
  for (let r = 0; r < 4; r++) {
    const surplus = current[r] - targets[r];
    if (surplus > overSurplus && workingByRes[r].length > 0) {
      overSurplus = surplus;
      over = r;
    }
    const deficit = targets[r] - current[r];
    if (deficit > underDeficit && targetsSrc[r] !== null) {
      underDeficit = deficit;
      under = r;
    }
  }
  if (over >= 0 && under >= 0 && over !== under) {
    const n = Math.min(ctx.tuning.rebalancePerThink, overSurplus, underDeficit, workingByRes[over].length);
    if (n > 0) {
      const movers = workingByRes[over].slice(0, n); // lowest-index first (ascending scan order)
      cmds.push(emitGather(world, player, movers, targetsSrc[under]!));
    }
  }

  return cmds;
}

export function planEconomy(ctx: AIContext): Command[] {
  const { world, player, scan } = ctx;
  const ps = scan.ps;
  const cmds: Command[] = [];

  // 1. House — keep the population cap ahead of the population. Wider buffer once multiple
  //    production buildings pop units concurrently; allow 2 concurrent houses at higher pops.
  const buffer = ps.age >= Age.Feudal ? POP_BUFFER_FEUDAL : POP_BUFFER;
  const maxConcurrentHouses = ps.population >= 20 ? 2 : 1;
  if (
    ps.populationCap < POP_CAP_HARD &&
    scan.underConstruction[BuildingType.House].length < maxConcurrentHouses &&
    ps.populationCap - ps.population <= buffer &&
    canAffordFree(ctx, BUILD_INFO[BuildingType.House].cost)
  ) {
    const cmd = emitBuild(ctx, BuildingType.House, ctx.ref);
    if (cmd) cmds.push(cmd);
  }

  // 2. Train villagers from ALL completed TCs (round-robin) while below the per-phase target and
  //    there is >= 50 food ABOVE the bank. Self-throttling: pauses when banking, resumes on surplus.
  const target = villagerTarget(ctx);
  let have = scan.villagers.length + queuedVillagers(world, scan);
  const tcs = scan.completeByType[BuildingType.TownCenter];
  for (let k = 0; k < tcs.length; k++) {
    const tc = tcs[k];
    if (have >= target) break;
    if (ps.population >= ps.populationCap) break;
    if (queueLen(world, tc) >= TC_QUEUE_MAX) continue;
    if (!canAffordFree(ctx, UNIT_INFO[UnitType.Villager].cost)) break;
    cmds.push({ type: 'train', player, building: handleOf(world, tc), unit: UnitType.Villager });
    spend(ctx.budget, UNIT_INFO[UnitType.Villager].cost);
    have++;
  }

  // 3. One resource building (Mill / camp / farm) if the resource picture calls for it.
  const rb = planResourceBuilding(ctx);
  if (rb) cmds.push(rb);

  // 4. Wheelbarrow — in FEUDAL_ECO only (before the Castle bank starts), TC free, comfortable food.
  if (
    ctx.phase === Phase.FeudalEco &&
    ps.researched[TechId.Wheelbarrow] !== 1 &&
    scan.tc >= 0 &&
    queueLen(world, scan.tc) === 0 &&
    !queueHasTech(world, scan.tc, TechId.Wheelbarrow) &&
    canAffordFree(ctx, TECH_INFO[TechId.Wheelbarrow].cost, 1.25)
  ) {
    cmds.push({ type: 'research', player, building: handleOf(world, scan.tc), tech: TechId.Wheelbarrow });
    spend(ctx.budget, TECH_INFO[TechId.Wheelbarrow].cost);
  }

  // 5. Gather rebalance — put idle villagers to work + shift the town toward its actual needs.
  for (const c of planGather(ctx)) cmds.push(c);

  return cmds;
}
