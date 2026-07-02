import { describe, it, expect } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { applyCommands } from '../../src/sim/commands';
import {
  BuildingType,
  CivId,
  EntityKind,
  FLAG_UNDER_CONSTRUCTION,
  GAIA,
  OrderType,
  UnitType,
} from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { World } from '../../src/shared/world';
import { resolveHandle } from '../../src/shared/world';
import { tileIndex } from '../../src/shared/constants';
import { canPlaceBuilding } from '../../src/map/tilemap';
import { resolveBuildingStats } from '../../src/content/stats';

function mkWorld(): World {
  return createWorld({
    seed: 7,
    mapSize: 48,
    players: [
      { civ: CivId.Britons, isAI: false },
      { civ: CivId.Franks, isAI: false },
    ],
  });
}

function findBuildingIdx(w: World, player: PlayerId, subtype: BuildingType): number {
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] !== EntityKind.Building) continue;
    if (w.comp.owner[i] !== player) continue;
    if (w.comp.subtype[i] !== subtype) continue;
    return i;
  }
  return -1;
}

function findUnitHandles(w: World, player: PlayerId, subtype: UnitType): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] !== EntityKind.Unit) continue;
    if (w.comp.owner[i] !== player) continue;
    if (w.comp.subtype[i] !== subtype) continue;
    out.push(w.em.handleFor(i));
  }
  return out;
}

function findSheepHandle(w: World): number {
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] === EntityKind.Unit && w.comp.subtype[i] === UnitType.Sheep) {
      return w.em.handleFor(i);
    }
  }
  return -1;
}

function findPlaceSpot(w: World, player: PlayerId, building: BuildingType): { tileX: number; tileY: number } | null {
  const bs = resolveBuildingStats(w, player, building);
  const tc = findBuildingIdx(w, player, BuildingType.TownCenter);
  const cx = Math.round(w.comp.posX[tc]);
  const cy = Math.round(w.comp.posY[tc]);
  for (let r = 3; r < 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tileX = cx + dx;
        const tileY = cy + dy;
        if (canPlaceBuilding(w.map, tileX, tileY, bs.sizeX, bs.sizeY)) {
          return { tileX, tileY };
        }
      }
    }
  }
  return null;
}

describe('applyCommands', () => {
  it('trains a villager, deducting cost and queueing the item', () => {
    const w = mkWorld();
    w.events.length = 0;
    const tcIdx = findBuildingIdx(w, 1, BuildingType.TownCenter);
    const tc = w.em.handleFor(tcIdx);
    const foodBefore = w.players[1].resources[0];

    applyCommands(w, [{ type: 'train', player: 1, building: tc, unit: UnitType.Villager }]);

    expect(w.players[1].resources[0]).toBe(foodBefore - 50);
    expect(w.comp.queue[tcIdx]).not.toBeNull();
    expect(w.comp.queue[tcIdx]!.length).toBe(1);
    expect(w.comp.queue[tcIdx]![0]).toMatchObject({ kind: 'unit', unit: UnitType.Villager });
    expect(w.events.some((e) => e.type === 'commandRejected')).toBe(false);
  });

  it('rejects training with insufficient resources and deducts nothing', () => {
    const w = mkWorld();
    w.events.length = 0;
    const tc = w.em.handleFor(findBuildingIdx(w, 1, BuildingType.TownCenter));
    w.players[1].resources[0] = 10; // < 50F

    applyCommands(w, [{ type: 'train', player: 1, building: tc, unit: UnitType.Villager }]);

    expect(w.players[1].resources[0]).toBe(10);
    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej).toBeTruthy();
    expect(rej && (rej as { reason: string }).reason).toBe('cost');
  });

  it('rejects a unit a building cannot train (Knight at TC in Dark Age)', () => {
    const w = mkWorld();
    w.events.length = 0;
    const tc = w.em.handleFor(findBuildingIdx(w, 1, BuildingType.TownCenter));

    applyCommands(w, [{ type: 'train', player: 1, building: tc, unit: UnitType.Knight }]);

    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej).toBeTruthy();
    expect(rej && (rej as { reason: string }).reason).toBe('invalid');
  });

  it('rejects building on occupied tiles (placement)', () => {
    const w = mkWorld();
    const tcIdx = findBuildingIdx(w, 1, BuildingType.TownCenter);
    const tcX0 = Math.round(w.comp.posX[tcIdx] - w.comp.sizeX[tcIdx] / 2);
    const tcY0 = Math.round(w.comp.posY[tcIdx] - w.comp.sizeY[tcIdx] / 2);
    const vill = findUnitHandles(w, 1, UnitType.Villager)[0];
    const woodBefore = w.players[1].resources[1];
    w.events.length = 0;

    applyCommands(w, [
      { type: 'build', player: 1, units: [vill], building: BuildingType.House, tileX: tcX0, tileY: tcY0 },
    ]);

    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej && (rej as { reason: string }).reason).toBe('placement');
    expect(w.players[1].resources[1]).toBe(woodBefore); // no deduction
  });

  it('places a valid building: deducts wood, spawns under-construction, occupies tiles, orders villager', () => {
    const w = mkWorld();
    const spot = findPlaceSpot(w, 1, BuildingType.House);
    expect(spot).not.toBeNull();
    const vill = findUnitHandles(w, 1, UnitType.Villager)[0];
    const villIdx = resolveHandle(w.em, vill);
    const woodBefore = w.players[1].resources[1];
    w.events.length = 0;

    applyCommands(w, [
      { type: 'build', player: 1, units: [vill], building: BuildingType.House, tileX: spot!.tileX, tileY: spot!.tileY },
    ]);

    expect(w.players[1].resources[1]).toBe(woodBefore - 25);
    const houseIdx = findBuildingIdx(w, 1, BuildingType.House);
    expect(houseIdx).toBeGreaterThanOrEqual(0);
    expect(w.comp.flags[houseIdx] & FLAG_UNDER_CONSTRUCTION).toBe(FLAG_UNDER_CONSTRUCTION);
    expect(w.comp.hp[houseIdx]).toBe(1);
    const occ = w.map.occupant[tileIndex(w.mapSize, spot!.tileX, spot!.tileY)];
    expect(occ).toBe(w.em.handleFor(houseIdx));
    expect(w.comp.orderType[villIdx]).toBe(OrderType.Build);
    expect(w.comp.orderTarget[villIdx]).toBe(w.em.handleFor(houseIdx));
  });

  it('cancelProduction refunds the enqueued cost', () => {
    const w = mkWorld();
    const tcIdx = findBuildingIdx(w, 1, BuildingType.TownCenter);
    const tc = w.em.handleFor(tcIdx);
    const foodBefore = w.players[1].resources[0];
    applyCommands(w, [{ type: 'train', player: 1, building: tc, unit: UnitType.Villager }]);
    expect(w.players[1].resources[0]).toBe(foodBefore - 50);

    applyCommands(w, [{ type: 'cancelProduction', player: 1, building: tc, queueIndex: 0 }]);
    expect(w.players[1].resources[0]).toBe(foodBefore);
    expect(w.comp.queue[tcIdx]!.length).toBe(0);
  });

  it('gatherEntity accepts a gaia sheep but rejects an enemy unit', () => {
    const w = mkWorld();
    const vill = findUnitHandles(w, 1, UnitType.Villager)[0];
    const villIdx = resolveHandle(w.em, vill);
    const sheep = findSheepHandle(w);
    expect(sheep).toBeGreaterThanOrEqual(0);
    w.events.length = 0;

    applyCommands(w, [{ type: 'gatherEntity', player: 1, units: [vill], target: sheep }]);
    expect(w.comp.orderType[villIdx]).toBe(OrderType.GatherEntity);
    expect(w.comp.orderTarget[villIdx]).toBe(sheep);

    // Enemy villager is not a valid gatherEntity target.
    const enemy = findUnitHandles(w, 2, UnitType.Villager)[0];
    w.events.length = 0;
    applyCommands(w, [{ type: 'gatherEntity', player: 1, units: [vill], target: enemy }]);
    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej && (rej as { reason: string }).reason).toBe('target');
  });

  it('attack accepts an enemy target but rejects an own unit', () => {
    const w = mkWorld();
    const attacker = findUnitHandles(w, 1, UnitType.ScoutCavalry)[0];
    const attIdx = resolveHandle(w.em, attacker);
    const enemy = findUnitHandles(w, 2, UnitType.Villager)[0];
    w.events.length = 0;

    applyCommands(w, [{ type: 'attack', player: 1, units: [attacker], target: enemy }]);
    expect(w.comp.orderType[attIdx]).toBe(OrderType.AttackTarget);
    expect(w.comp.orderTarget[attIdx]).toBe(enemy);

    const ownVill = findUnitHandles(w, 1, UnitType.Villager)[0];
    w.events.length = 0;
    applyCommands(w, [{ type: 'attack', player: 1, units: [attacker], target: ownVill }]);
    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej && (rej as { reason: string }).reason).toBe('target');
  });

  it('filters non-villagers out of gather commands', () => {
    const w = mkWorld();
    const scout = findUnitHandles(w, 1, UnitType.ScoutCavalry)[0];
    const scoutIdx = resolveHandle(w.em, scout);
    const sheep = findSheepHandle(w);
    const before = w.comp.orderType[scoutIdx];
    w.events.length = 0;

    applyCommands(w, [{ type: 'gatherEntity', player: 1, units: [scout], target: sheep }]);
    // Scout is dropped from the gather; its order is unchanged.
    expect(w.comp.orderType[scoutIdx]).toBe(before);
  });

  it('rejects commands from Gaia / invalid players', () => {
    const w = mkWorld();
    w.events.length = 0;
    applyCommands(w, [{ type: 'stop', player: GAIA, units: [] }]);
    const rej = w.events.find((e) => e.type === 'commandRejected');
    expect(rej && (rej as { reason: string }).reason).toBe('player');
  });
});
