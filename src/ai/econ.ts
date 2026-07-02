// src/ai/econ.ts
//
// Economy planner: keep villagers productive, grow the villager count, stay ahead of the
// population cap, and place drop-off camps / farms as the resource picture changes.
// Pure Command emitter — reads World only, mutates nothing.

import {
  Age,
  BuildingType,
  UnitType,
  Resource,
  ResourceNode,
} from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { World, Rng } from '../shared/world';
import type { Command } from '../shared/commands';
import type { AIConfig } from '../shared/interfaces';
import {
  BUILD_INFO,
  UNIT_INFO,
  PLACE_SEARCH_RADIUS,
  RESOURCE_SEARCH_RADIUS,
  CAMP_DISTANCE_THRESHOLD,
  TC_QUEUE_MAX,
  POP_BUFFER,
  POP_CAP_HARD,
  scanPlayer,
  reservableBuilders,
  canAfford,
  handleOf,
  queueLen,
  refTile,
  tileCenterX,
  tileCenterY,
  findNearestNode,
  findNearestSheep,
  findNearestOwnFarm,
  findPlacement,
  minDistToBuildings,
  villagerResource,
  type PlayerScan,
} from './ai';

interface GatherTarget {
  kind: 'tile' | 'entity';
  id: number; // tile index (tile) or entity handle (entity)
}

/** Percent split of villagers across [Food, Wood, Gold, Stone] by age. */
function gatherSplit(age: Age): [number, number, number, number] {
  if (age <= Age.Dark) return [0.6, 0.4, 0, 0];
  if (age === Age.Feudal) return [0.45, 0.35, 0.2, 0];
  return [0.4, 0.3, 0.2, 0.1]; // Castle / Imperial
}

/** Pick the lowest-index idle villager not yet reserved this think; mark it used. -1 if none. */
function reserveLowBuilder(idle: number[], used: Set<number>): number {
  for (let k = 0; k < idle.length; k++) {
    const i = idle[k];
    if (!used.has(i)) {
      used.add(i);
      return i;
    }
  }
  return -1;
}

function resolveGatherTargets(world: World, player: PlayerId, ref: number): (GatherTarget | null)[] {
  const refX = tileCenterX(world, ref);
  const refY = tileCenterY(world, ref);
  const targets: (GatherTarget | null)[] = [null, null, null, null];

  // Food: forage first, then sheep, then a standing farm.
  const forage = findNearestNode(world, ref, ResourceNode.Forage, RESOURCE_SEARCH_RADIUS);
  if (forage >= 0) {
    targets[Resource.Food] = { kind: 'tile', id: forage };
  } else {
    const sheep = findNearestSheep(world, refX, refY);
    if (sheep >= 0) {
      targets[Resource.Food] = { kind: 'entity', id: sheep };
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

/** Distribute the given idle villagers across resources per the age split, honoring reachable targets. */
function assignGather(
  world: World,
  player: PlayerId,
  scan: PlayerScan,
  idle: number[],
  targets: (GatherTarget | null)[],
): Command[] {
  if (idle.length === 0) return [];
  const split = gatherSplit(scan.ps.age);
  const total = scan.villagers.length || 1;

  const current: number[] = [0, 0, 0, 0];
  for (let k = 0; k < scan.villagers.length; k++) {
    const r = villagerResource(world, scan.villagers[k]);
    if (r >= 0) current[r]++;
  }
  const desired: number[] = [split[0] * total, split[1] * total, split[2] * total, split[3] * total];

  const groups: number[][] = [[], [], [], []];
  for (let k = 0; k < idle.length; k++) {
    const vi = idle[k];
    let bestR = -1;
    let bestGap = -Infinity;
    for (let r = 0; r < 4; r++) {
      if (split[r] <= 0 || targets[r] === null) continue;
      const gap = desired[r] - current[r];
      if (gap > bestGap) {
        bestGap = gap;
        bestR = r;
      }
    }
    if (bestR < 0) {
      // No split-eligible target: fall back to wood, then food, then skip.
      if (targets[Resource.Wood] !== null) bestR = Resource.Wood;
      else if (targets[Resource.Food] !== null) bestR = Resource.Food;
      else continue;
    }
    groups[bestR].push(vi);
    current[bestR]++;
  }

  const cmds: Command[] = [];
  for (let r = 0; r < 4; r++) {
    const g = groups[r];
    const t = targets[r];
    if (g.length === 0 || t === null) continue;
    const units = g.map((i) => handleOf(world, i));
    if (t.kind === 'tile') cmds.push({ type: 'gatherTile', player, units, tile: t.id });
    else cmds.push({ type: 'gatherEntity', player, units, target: t.id });
  }
  return cmds;
}

/**
 * Choose at most ONE resource building to construct this think, in priority order:
 * Mill (for farms / far forage) -> LumberCamp -> MiningCamp -> Farm. Emits the build command and
 * reserves a builder, or returns null.
 */
function planResourceBuilding(
  world: World,
  player: PlayerId,
  scan: PlayerScan,
  rng: Rng,
  ref: number,
  idle: number[],
  used: Set<number>,
): Command | null {
  const ps = scan.ps;
  const woodDropoffs = scan.completeByType[BuildingType.TownCenter].concat(scan.completeByType[BuildingType.LumberCamp]);
  const foodDropoffs = scan.completeByType[BuildingType.TownCenter].concat(scan.completeByType[BuildingType.Mill]);
  const miningDropoffs = scan.completeByType[BuildingType.TownCenter].concat(scan.completeByType[BuildingType.MiningCamp]);

  const forage = findNearestNode(world, ref, ResourceNode.Forage, RESOURCE_SEARCH_RADIUS);
  const millExists =
    scan.completeByType[BuildingType.Mill].length + scan.underConstruction[BuildingType.Mill].length > 0;

  // 1. Mill — needed for farms and for distant forage.
  if (!millExists && canAfford(ps, BUILD_INFO[BuildingType.Mill].cost)) {
    const forageFar =
      forage >= 0 &&
      minDistToBuildings(world, tileCenterX(world, forage), tileCenterY(world, forage), foodDropoffs) >
        CAMP_DISTANCE_THRESHOLD;
    const noForage = forage < 0;
    if (forageFar || noForage) {
      const near = forage >= 0 ? forage : ref;
      const cmd = emitBuild(world, player, BuildingType.Mill, near, rng, idle, used);
      if (cmd) return cmd;
    }
  }

  // 2. LumberCamp near a distant forest.
  if (
    scan.completeByType[BuildingType.LumberCamp].length + scan.underConstruction[BuildingType.LumberCamp].length === 0 &&
    canAfford(ps, BUILD_INFO[BuildingType.LumberCamp].cost)
  ) {
    const tree = findNearestNode(world, ref, ResourceNode.Tree, RESOURCE_SEARCH_RADIUS);
    if (
      tree >= 0 &&
      minDistToBuildings(world, tileCenterX(world, tree), tileCenterY(world, tree), woodDropoffs) > CAMP_DISTANCE_THRESHOLD
    ) {
      const cmd = emitBuild(world, player, BuildingType.LumberCamp, tree, rng, idle, used);
      if (cmd) return cmd;
    }
  }

  // 3. MiningCamp near a distant gold/stone deposit (only worth it once mining, i.e. Feudal+).
  if (
    ps.age >= Age.Feudal &&
    scan.completeByType[BuildingType.MiningCamp].length + scan.underConstruction[BuildingType.MiningCamp].length === 0 &&
    canAfford(ps, BUILD_INFO[BuildingType.MiningCamp].cost)
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
      const cmd = emitBuild(world, player, BuildingType.MiningCamp, node, rng, idle, used);
      if (cmd) return cmd;
    }
  }

  // 4. Farm — once forage is gone, up to age*3 farms, requires a Mill.
  const maxFarms = ps.age * 3;
  if (maxFarms > 0 && millExists && forage < 0 && canAfford(ps, BUILD_INFO[BuildingType.Farm].cost)) {
    const farmCount = scan.completeByType[BuildingType.Farm].length + scan.underConstruction[BuildingType.Farm].length;
    if (farmCount < maxFarms) {
      const near =
        scan.completeByType[BuildingType.Mill].length > 0
          ? buildingRefTile(world, scan.completeByType[BuildingType.Mill][0])
          : ref;
      const cmd = emitBuild(world, player, BuildingType.Farm, near, rng, idle, used);
      if (cmd) return cmd;
    }
  }

  return null;
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

/** Reserve a builder + find a placement near `nearTile`; emit a build command or return null. */
function emitBuild(
  world: World,
  player: PlayerId,
  building: BuildingType,
  nearTile: number,
  rng: Rng,
  idle: number[],
  used: Set<number>,
): Command | null {
  // peek a free builder without reserving until placement succeeds
  let builder = -1;
  for (let k = 0; k < idle.length; k++) {
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

export function planEconomy(world: World, player: PlayerId, cfg: AIConfig, rng: Rng): Command[] {
  const scan = scanPlayer(world, player);
  const ps = scan.ps;
  const cmds: Command[] = [];
  // Builders draft idle villagers first, then active gatherers (econ from the low end) — see
  // reservableBuilders. Without drafting gatherers, Houses stop being built once every villager
  // is gathering and the population cap (hence the army) freezes forever.
  const builders = reservableBuilders(world, scan);
  const used = new Set<number>();
  const ref = refTile(world, scan);

  // 1. House — keep the population cap ahead of the population.
  if (
    ps.populationCap < POP_CAP_HARD &&
    scan.underConstruction[BuildingType.House].length === 0 &&
    ps.populationCap - ps.population <= POP_BUFFER &&
    canAfford(ps, BUILD_INFO[BuildingType.House].cost)
  ) {
    const cmd = emitBuild(world, player, BuildingType.House, ref, rng, builders, used);
    if (cmd) cmds.push(cmd);
  }

  // 2. Train villagers up to the configured cap (population permitting).
  if (
    scan.tc >= 0 &&
    scan.villagers.length < cfg.maxVillagers &&
    ps.population < ps.populationCap &&
    canAfford(ps, UNIT_INFO[UnitType.Villager].cost) &&
    queueLen(world, scan.tc) < TC_QUEUE_MAX
  ) {
    cmds.push({ type: 'train', player, building: handleOf(world, scan.tc), unit: UnitType.Villager });
  }

  // 3. One resource building (Mill / camp / farm) if the resource picture calls for it.
  const rb = planResourceBuilding(world, player, scan, rng, ref, builders, used);
  if (rb) cmds.push(rb);

  // 4. Put remaining IDLE villagers to work per the age gather split (drafted gatherers already
  //    have a job — only truly idle villagers need a new gather order).
  const remaining: number[] = [];
  const idle = scan.idleVillagers;
  for (let k = 0; k < idle.length; k++) if (!used.has(idle[k])) remaining.push(idle[k]);
  if (remaining.length > 0) {
    const targets = resolveGatherTargets(world, player, ref);
    for (const c of assignGather(world, player, scan, remaining, targets)) cmds.push(c);
  }

  return cmds;
}
