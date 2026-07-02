// T4 sim engine — command validation + application (review requiredChanges #9).
import { inBounds } from '../shared/constants';
import {
  BuildingType,
  EntityKind,
  FLAG_UNDER_CONSTRUCTION,
  GAIA,
  OrderType,
  ResourceNode,
  UnitType,
} from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { Command } from '../shared/commands';
import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import {
  canBuildBuilding,
  canResearch,
  canTrain,
  resolveBuildingStats,
  resolveCost,
  resolveUnitStats,
} from '../content/stats';
import { BUILDING_STATS } from '../content/buildings';
import { TECHS } from '../content/techs';
import { canPlaceBuilding } from '../map/tilemap';
import { emit, hasCompletedBuilding, payCost, refundCost, spawnBuilding } from './actions';
import { clearPath } from './movement';

function reject(world: World, command: Command, reason: string): void {
  emit(world, { type: 'commandRejected', player: command.player, command, reason });
}

/** Filter a command's unit-handle list to alive units owned by the caller. Optionally drop
 *  non-villagers (gather/build). Returns entity INDEXES sorted ascending for determinism. */
function collectUnits(
  world: World,
  player: PlayerId,
  handles: number[],
  villagersOnly: boolean,
): number[] {
  const { comp, em } = world;
  const out: number[] = [];
  for (let k = 0; k < handles.length; k++) {
    const idx = resolveHandle(em, handles[k]);
    if (idx < 0) continue;
    if (comp.owner[idx] !== player) continue;
    if (comp.kind[idx] !== EntityKind.Unit) continue;
    if (villagersOnly && comp.subtype[idx] !== UnitType.Villager) continue;
    out.push(idx);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Resolve a command's building handle to a valid, owned, completed building index, or -1. */
function resolveOwnBuilding(world: World, player: PlayerId, handle: number): number {
  const { comp, em } = world;
  const idx = resolveHandle(em, handle);
  if (idx < 0) return -1;
  if (comp.kind[idx] !== EntityKind.Building) return -1;
  if (comp.owner[idx] !== player) return -1;
  return idx;
}

/** Validate and apply every command in array order. All mutation of the sim originates here. */
export function applyCommands(world: World, commands: Command[]): void {
  const { comp, em, map } = world;
  const size = map.size;

  for (let c = 0; c < commands.length; c++) {
    const cmd = commands[c];
    const player = cmd.player;
    if (player <= 0 || player >= world.players.length) {
      reject(world, cmd, 'player');
      continue;
    }

    switch (cmd.type) {
      case 'stop': {
        const units = collectUnits(world, player, cmd.units, false);
        for (const i of units) {
          comp.orderType[i] = OrderType.Idle;
          comp.orderTarget[i] = -1;
          comp.orderTile[i] = -1;
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          comp.workTimer[i] = 0;
          clearPath(world, i);
        }
        break;
      }

      case 'move':
      case 'attackMove': {
        const units = collectUnits(world, player, cmd.units, false);
        const ot = cmd.type === 'move' ? OrderType.Move : OrderType.AttackMove;
        for (const i of units) {
          comp.orderType[i] = ot;
          comp.orderX[i] = cmd.x;
          comp.orderY[i] = cmd.y;
          comp.orderTarget[i] = -1;
          comp.orderTile[i] = -1;
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          clearPath(world, i);
        }
        break;
      }

      case 'attack': {
        const t = resolveHandle(em, cmd.target);
        if (t < 0 || comp.owner[t] === player) {
          reject(world, cmd, 'target');
          break;
        }
        const units = collectUnits(world, player, cmd.units, false);
        for (const i of units) {
          comp.orderType[i] = OrderType.AttackTarget;
          comp.orderTarget[i] = cmd.target;
          comp.orderX[i] = comp.posX[t];
          comp.orderY[i] = comp.posY[t];
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          clearPath(world, i);
        }
        break;
      }

      case 'gatherTile': {
        const tile = cmd.tile;
        if (tile < 0 || tile >= size * size) {
          reject(world, cmd, 'target');
          break;
        }
        if (map.resourceType[tile] === ResourceNode.None) {
          reject(world, cmd, 'target');
          break;
        }
        const units = collectUnits(world, player, cmd.units, true);
        for (const i of units) {
          comp.orderType[i] = OrderType.GatherTile;
          comp.orderTile[i] = tile;
          comp.orderTarget[i] = -1;
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          comp.workTimer[i] = 0;
          clearPath(world, i);
        }
        break;
      }

      case 'gatherEntity': {
        const t = resolveHandle(em, cmd.target);
        const valid =
          t >= 0 &&
          ((comp.owner[t] === GAIA &&
            comp.kind[t] === EntityKind.Unit &&
            comp.subtype[t] === UnitType.Sheep) ||
            (comp.owner[t] === player &&
              comp.kind[t] === EntityKind.Building &&
              comp.subtype[t] === BuildingType.Farm &&
              (comp.flags[t] & FLAG_UNDER_CONSTRUCTION) === 0));
        if (!valid) {
          reject(world, cmd, 'target');
          break;
        }
        const units = collectUnits(world, player, cmd.units, true);
        for (const i of units) {
          comp.orderType[i] = OrderType.GatherEntity;
          comp.orderTarget[i] = cmd.target;
          comp.orderTile[i] = -1;
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          comp.workTimer[i] = 0;
          clearPath(world, i);
        }
        break;
      }

      case 'build': {
        const building = cmd.building;
        if (!canBuildBuilding(world, player, building)) {
          reject(world, cmd, 'age');
          break;
        }
        const req = BUILDING_STATS[building].requiresBuilding;
        if (req !== -1 && !hasCompletedBuilding(world, player, req)) {
          reject(world, cmd, 'prereq');
          break;
        }
        const bs = resolveBuildingStats(world, player, building);
        if (!inBounds(size, cmd.tileX, cmd.tileY) || !canPlaceBuilding(map, cmd.tileX, cmd.tileY, bs.sizeX, bs.sizeY)) {
          reject(world, cmd, 'placement');
          break;
        }
        const cost = resolveCost(world, player, { building });
        if (!payCost(world, player, cost)) {
          reject(world, cmd, 'cost');
          break;
        }
        const handle = spawnBuilding(world, player, building, cmd.tileX, cmd.tileY, false);
        const units = collectUnits(world, player, cmd.units, true);
        for (const i of units) {
          comp.orderType[i] = OrderType.Build;
          comp.orderTarget[i] = handle;
          comp.orderTile[i] = -1;
          comp.resumeTarget[i] = -1;
          comp.resumeTile[i] = -1;
          clearPath(world, i);
        }
        break;
      }

      case 'train': {
        const b = resolveOwnBuilding(world, player, cmd.building);
        if (b < 0) {
          reject(world, cmd, 'target');
          break;
        }
        if ((comp.flags[b] & FLAG_UNDER_CONSTRUCTION) !== 0) {
          reject(world, cmd, 'construction');
          break;
        }
        if (!canTrain(world, player, comp.subtype[b] as BuildingType, cmd.unit)) {
          reject(world, cmd, 'invalid');
          break;
        }
        const cost = resolveCost(world, player, { unit: cmd.unit });
        if (!payCost(world, player, cost)) {
          reject(world, cmd, 'cost');
          break;
        }
        const totalTicks = resolveUnitStats(world, player, cmd.unit).trainTicks;
        if (comp.queue[b] === null) comp.queue[b] = [];
        comp.queue[b]!.push({ kind: 'unit', unit: cmd.unit, ticksLeft: totalTicks, totalTicks });
        break;
      }

      case 'research': {
        const b = resolveOwnBuilding(world, player, cmd.building);
        if (b < 0) {
          reject(world, cmd, 'target');
          break;
        }
        if ((comp.flags[b] & FLAG_UNDER_CONSTRUCTION) !== 0) {
          reject(world, cmd, 'construction');
          break;
        }
        if (TECHS[cmd.tech].researchedAt !== comp.subtype[b]) {
          reject(world, cmd, 'building');
          break;
        }
        if (!canResearch(world, player, cmd.tech)) {
          reject(world, cmd, 'invalid');
          break;
        }
        const rb = TECHS[cmd.tech].requiresBuilding;
        if (rb !== -1 && !hasCompletedBuilding(world, player, rb)) {
          reject(world, cmd, 'prereq');
          break;
        }
        const cost = resolveCost(world, player, { tech: cmd.tech });
        if (!payCost(world, player, cost)) {
          reject(world, cmd, 'cost');
          break;
        }
        const totalTicks = TECHS[cmd.tech].researchTicks;
        if (comp.queue[b] === null) comp.queue[b] = [];
        comp.queue[b]!.push({ kind: 'tech', tech: cmd.tech, ticksLeft: totalTicks, totalTicks });
        break;
      }

      case 'cancelProduction': {
        const b = resolveOwnBuilding(world, player, cmd.building);
        if (b < 0) {
          reject(world, cmd, 'target');
          break;
        }
        const q = comp.queue[b];
        if (q === null || cmd.queueIndex < 0 || cmd.queueIndex >= q.length) {
          reject(world, cmd, 'invalid');
          break;
        }
        const item = q[cmd.queueIndex];
        const cost =
          item.kind === 'unit'
            ? resolveCost(world, player, { unit: item.unit })
            : resolveCost(world, player, { tech: item.tech });
        refundCost(world, player, cost);
        q.splice(cmd.queueIndex, 1);
        break;
      }

      case 'setRally': {
        const b = resolveOwnBuilding(world, player, cmd.building);
        if (b < 0) {
          reject(world, cmd, 'target');
          break;
        }
        comp.rallyX[b] = cmd.x;
        comp.rallyY[b] = cmd.y;
        break;
      }

      default: {
        // Exhaustiveness guard.
        const _never: never = cmd;
        void _never;
      }
    }
  }
}
