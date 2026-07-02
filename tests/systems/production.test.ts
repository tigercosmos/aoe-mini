import { describe, it, expect, vi } from 'vitest';

// T4 sim modules are not written yet; mock them with contract-faithful fakes.
vi.mock('../../src/sim/movement', () => ({
  requestPath: (): boolean => true,
  clearPath: (world: any, index: number): void => {
    world.comp.path[index] = null;
    world.comp.pathStep[index] = -1;
  },
}));
vi.mock('../../src/sim/actions', () => ({
  emit: (world: any, ev: any): void => {
    world.events.push(ev);
  },
  spawnUnit: (world: any, owner: number, unit: number, x: number, y: number): number => {
    const i = world.em.create();
    const c = world.comp;
    c.kind[i] = 0; // Unit
    c.subtype[i] = unit;
    c.owner[i] = owner;
    c.posX[i] = x;
    c.posY[i] = y;
    c.orderType[i] = 0; // Idle
    world.players[owner].population += 1; // villager popCost 1
    world.__spawns.push({ owner, unit, x, y, index: i });
    return ((world.em.generation[i] << 12) | i) >>> 0;
  },
  damageEntity: (): void => {},
  completeConstruction: (): void => {},
  findDropOff: (): number => -1,
  recomputePopCap: (): void => {},
}));

import { productionSystem } from '../../src/systems/production';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores } from '../../src/core/components';
import { createSpatialGrid } from '../../src/core/spatial';
import { createTileMap } from '../../src/map/tilemap';
import { createPathCache } from '../../src/map/pathcache';
import { resolveBuildingStats } from '../../src/content/stats';
import type { World, ProductionItem } from '../../src/shared/world';
import {
  EntityKind,
  OrderType,
  UnitType,
  BuildingType,
  TechId,
  Age,
  CivId,
  GAIA,
  MatchStatus,
  RESOURCE_COUNT,
  TECH_COUNT,
  FLAG_UNDER_CONSTRUCTION,
} from '../../src/shared/enums';

function makePlayer(id: number, civ: number, alive: boolean) {
  return {
    id,
    civ,
    isAI: false,
    alive,
    resources: new Float32Array(RESOURCE_COUNT),
    population: 0,
    populationCap: 200,
    age: Age.Dark,
    researched: new Uint8Array(TECH_COUNT),
    statsVersion: 0,
  };
}

function makeWorld(size = 24): any {
  const cap = 64;
  const world: any = {
    tick: 0,
    seed: 1,
    rng: { s: 1 },
    mapSize: size,
    em: createEntityManager(cap),
    comp: createComponentStores(cap),
    map: createTileMap(size),
    grid: createSpatialGrid(size),
    pathCache: createPathCache(),
    players: [makePlayer(GAIA, CivId.Britons, false), makePlayer(1, CivId.Britons, true)],
    events: [],
    status: MatchStatus.Running,
    winner: -1,
    __spawns: [],
  };
  return world;
}

function addBuilding(world: any, owner: number, b: BuildingType, tx: number, ty: number): number {
  const c = world.comp;
  const i = world.em.create();
  const bs = resolveBuildingStats(world, owner, b);
  c.kind[i] = EntityKind.Building;
  c.subtype[i] = b;
  c.owner[i] = owner;
  c.sizeX[i] = bs.sizeX;
  c.sizeY[i] = bs.sizeY;
  c.posX[i] = tx + bs.sizeX / 2;
  c.posY[i] = ty + bs.sizeY / 2;
  c.maxHp[i] = bs.hp;
  c.hp[i] = bs.hp;
  c.flags[i] = 0; // completed
  c.rallyX[i] = -1;
  c.rallyY[i] = -1;
  for (let dy = 0; dy < bs.sizeY; dy++) {
    for (let dx = 0; dx < bs.sizeX; dx++) {
      world.map.occupant[(ty + dy) * world.map.size + (tx + dx)] = world.em.handleFor(i);
    }
  }
  return i;
}

function addUnit(world: any, owner: number, unit: UnitType, x: number, y: number, hp: number): number {
  const c = world.comp;
  const i = world.em.create();
  c.kind[i] = EntityKind.Unit;
  c.subtype[i] = unit;
  c.owner[i] = owner;
  c.posX[i] = x;
  c.posY[i] = y;
  c.hp[i] = hp;
  c.maxHp[i] = hp;
  c.orderType[i] = OrderType.Idle;
  world.players[owner].population += 1;
  return i;
}

function unitItem(unit: UnitType, ticks: number): ProductionItem {
  return { kind: 'unit', unit, ticksLeft: ticks, totalTicks: ticks };
}
function techItem(tech: TechId, ticks: number): ProductionItem {
  return { kind: 'tech', tech, ticksLeft: ticks, totalTicks: ticks };
}
function run(world: any, n: number): void {
  for (let k = 0; k < n; k++) {
    productionSystem(world);
    world.tick++;
  }
}

describe('productionSystem', () => {
  it('trains a villager in exactly 500 ticks', () => {
    const world = makeWorld();
    const tc = addBuilding(world, 1, BuildingType.TownCenter, 5, 5);
    world.comp.queue[tc] = [unitItem(UnitType.Villager, 500)];

    run(world, 499);
    expect(world.__spawns.length).toBe(0);
    run(world, 1);
    expect(world.__spawns.length).toBe(1);
    expect(world.__spawns[0].unit).toBe(UnitType.Villager);
    expect(world.comp.queue[tc]!.length).toBe(0);
  });

  it('holds a pop-blocked unit at the threshold and releases it when cap rises', () => {
    const world = makeWorld();
    const tc = addBuilding(world, 1, BuildingType.TownCenter, 5, 5);
    world.players[1].populationCap = 0; // any new unit is blocked
    world.comp.queue[tc] = [unitItem(UnitType.Villager, 10)];

    run(world, 60); // long past completion
    expect(world.__spawns.length).toBe(0);
    expect(world.comp.queue[tc]!.length).toBe(1);
    expect(world.comp.queue[tc]![0].ticksLeft).toBe(0);

    world.players[1].populationCap = 5; // room now
    run(world, 1);
    expect(world.__spawns.length).toBe(1);
    expect(world.comp.queue[tc]!.length).toBe(0);
  });

  it('applies a rally point as a Move order on the fresh unit', () => {
    const world = makeWorld();
    const tc = addBuilding(world, 1, BuildingType.TownCenter, 5, 5);
    world.comp.rallyX[tc] = 15;
    world.comp.rallyY[tc] = 16;
    world.comp.queue[tc] = [unitItem(UnitType.Villager, 1)];

    run(world, 1);
    const spawn = world.__spawns[0];
    expect(spawn).toBeTruthy();
    expect(world.comp.orderType[spawn.index]).toBe(OrderType.Move);
    expect(world.comp.orderX[spawn.index]).toBe(15);
    expect(world.comp.orderY[spawn.index]).toBe(16);
  });

  it('completes FeudalAge: researched flag, age advances, researchComplete + ageAdvanced events', () => {
    const world = makeWorld();
    const tc = addBuilding(world, 1, BuildingType.TownCenter, 5, 5);
    world.comp.queue[tc] = [techItem(TechId.FeudalAge, 1)];

    run(world, 1);
    expect(world.players[1].researched[TechId.FeudalAge]).toBe(1);
    expect(world.players[1].age).toBe(Age.Feudal);
    expect(world.events.some((e: any) => e.type === 'researchComplete' && e.tech === TechId.FeudalAge)).toBe(true);
    expect(world.events.some((e: any) => e.type === 'ageAdvanced' && e.age === Age.Feudal)).toBe(true);
    expect(world.comp.queue[tc]!.length).toBe(0);
  });

  it('ManAtArmsUpgrade converts a live Militia to Man-at-Arms via applyTechEffects', () => {
    const world = makeWorld();
    world.players[1].age = Age.Feudal;
    world.players[1].statsVersion++; // reflect age change for the resolver memo
    const barracks = addBuilding(world, 1, BuildingType.Barracks, 5, 5);
    const militia = addUnit(world, 1, UnitType.Militia, 12, 12, 40);
    world.comp.queue[barracks] = [techItem(TechId.ManAtArmsUpgrade, 1)];

    run(world, 1);
    expect(world.comp.subtype[militia]).toBe(UnitType.ManAtArms);
    expect(world.comp.maxHp[militia]).toBe(45);
    expect(world.comp.hp[militia]).toBe(45);
    expect(world.events.some((e: any) => e.type === 'researchComplete' && e.tech === TechId.ManAtArmsUpgrade)).toBe(true);
  });

  it('ManAtArmsUpgrade converts pending QUEUED Militia items to Man-at-Arms (ticksLeft unchanged)', () => {
    const world = makeWorld();
    world.players[1].age = Age.Feudal;
    world.players[1].statsVersion++;
    const b1 = addBuilding(world, 1, BuildingType.Barracks, 5, 5); // lower index: researches tech
    const b2 = addBuilding(world, 1, BuildingType.Barracks, 12, 12); // has a queued Militia
    world.comp.queue[b1] = [techItem(TechId.ManAtArmsUpgrade, 1)];
    world.comp.queue[b2] = [unitItem(UnitType.Militia, 300)];

    run(world, 1);
    const converted = world.comp.queue[b2]![0];
    expect(converted.kind).toBe('unit');
    expect((converted as any).unit).toBe(UnitType.ManAtArms);
    expect(converted.ticksLeft).toBe(299); // converted at 300, then the normal -1 this tick
  });
});
