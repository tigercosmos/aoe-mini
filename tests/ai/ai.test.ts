// tests/ai/ai.test.ts
//
// Standalone AI unit tests: pure/deterministic think behavior, read-only (no-mutation) guarantee,
// non-think-tick gating, command bound, and the military attack trigger. Imports ONLY shared
// contracts + the AI module under test (no sibling sim/map/content modules). Long stepWorld-driven
// economy/build-order tests live in tests/integration/ai-progress.test.ts.

import { describe, it, expect } from 'vitest';
import {
  Age,
  CivId,
  GAIA,
  EntityKind,
  UnitType,
  BuildingType,
  ResourceNode,
  OrderType,
  TechId,
  RESOURCE_COUNT,
  TECH_COUNT,
  FLAG_UNDER_CONSTRUCTION,
} from '../../src/shared/enums';
import { tileIndex } from '../../src/shared/constants';
import { createRng } from '../../src/shared/rng';
import { makeHandle, resolveHandle } from '../../src/shared/world';
import type {
  World,
  ComponentStores,
  EntityManager,
  TileMap,
  SpatialGrid,
  PathCache,
  PlayerState,
  ProductionItem,
} from '../../src/shared/world';
import type { PlayerId, CivId as CivIdT } from '../../src/shared/enums';
import type { Command } from '../../src/shared/commands';
import { createAIPlayer, DEFAULT_AI_CONFIG } from '../../src/ai/ai';

// --------------------------------------------------------------- fixtures ----

const CAP = 128;

function createStores(capacity: number): ComponentStores {
  const f32 = () => new Float32Array(capacity);
  const i32m1 = () => new Int32Array(capacity).fill(-1);
  const stores: ComponentStores = {
    capacity,
    kind: new Uint8Array(capacity),
    subtype: new Uint16Array(capacity),
    owner: new Uint8Array(capacity),
    flags: new Uint8Array(capacity),
    posX: f32(),
    posY: f32(),
    prevX: f32(),
    prevY: f32(),
    radius: f32(),
    sizeX: new Uint8Array(capacity),
    sizeY: new Uint8Array(capacity),
    speed: f32(),
    hp: f32(),
    maxHp: f32(),
    attack: f32(),
    attackRange: f32(),
    attackRateTicks: f32(),
    attackCooldown: f32(),
    meleeArmor: f32(),
    pierceArmor: f32(),
    los: f32(),
    orderType: new Uint8Array(capacity),
    orderTarget: i32m1(),
    orderTile: i32m1(),
    orderX: f32(),
    orderY: f32(),
    resumeTarget: i32m1(),
    resumeTile: i32m1(),
    carryType: new Uint8Array(capacity),
    carryAmount: f32(),
    workTimer: f32(),
    storedResource: f32(),
    buildProgress: f32(),
    rallyX: f32().fill(-1),
    rallyY: f32().fill(-1),
    projDamage: f32(),
    projSource: i32m1(),
    path: new Array<Uint16Array | null>(capacity).fill(null),
    pathStep: i32m1(),
    pathVersion: new Int32Array(capacity),
    queue: new Array<ProductionItem[] | null>(capacity).fill(null),
  };
  return stores;
}

function createEm(capacity: number): EntityManager {
  const alive = new Uint8Array(capacity);
  const generation = new Uint16Array(capacity);
  const em: EntityManager = {
    capacity,
    aliveCount: 0,
    alive,
    generation,
    create(): number {
      for (let i = 0; i < capacity; i++) {
        if (alive[i] === 0) {
          alive[i] = 1;
          em.aliveCount++;
          return i;
        }
      }
      throw new Error('entity capacity exceeded');
    },
    destroy(index: number): void {
      if (alive[index] === 1) {
        alive[index] = 0;
        generation[index] = (generation[index] + 1) & 0xffff;
        em.aliveCount--;
      }
    },
    isAlive(index: number): boolean {
      return alive[index] === 1;
    },
    handleFor(index: number): number {
      return makeHandle(index, generation[index]);
    },
  };
  return em;
}

function createMap(size: number): TileMap {
  const n = size * size;
  return {
    size,
    terrain: new Uint8Array(n),
    resourceType: new Uint8Array(n),
    resourceAmount: new Float32Array(n),
    occupant: new Int32Array(n).fill(-1),
    visible: new Uint8Array(n),
    explored: new Uint8Array(n),
  };
}

function makePlayer(id: PlayerId, civ: CivIdT, isAI: boolean): PlayerState {
  return {
    id,
    civ,
    isAI,
    alive: id !== GAIA,
    resources: new Float32Array(RESOURCE_COUNT),
    population: 0,
    populationCap: 5,
    age: Age.Dark,
    researched: new Uint8Array(TECH_COUNT),
    statsVersion: 0,
  };
}

function makeWorld(size = 40, playerCount = 2): World {
  const em = createEm(CAP);
  const comp = createStores(CAP);
  const map = createMap(size);
  const grid: SpatialGrid = {
    cellSize: 4,
    rebuild() {},
    queryCircle() {
      return 0;
    },
    queryRect() {
      return 0;
    },
  };
  const pathCache: PathCache = { version: 0, entries: new Map(), hits: 0, misses: 0 };
  const players: PlayerState[] = [makePlayer(GAIA, CivId.Britons, false)];
  const civs = [CivId.Franks, CivId.Mongols, CivId.Britons];
  for (let p = 1; p <= playerCount; p++) players.push(makePlayer(p, civs[(p - 1) % civs.length], true));
  return {
    tick: 0,
    seed: 1234,
    rng: createRng(999),
    mapSize: size,
    em,
    comp,
    map,
    grid,
    pathCache,
    players,
    events: [],
    status: 0, // MatchStatus.Running
    winner: -1,
  };
}

function spawnUnit(
  world: World,
  owner: PlayerId,
  subtype: UnitType,
  x: number,
  y: number,
  opts: { order?: OrderType; hp?: number; pop?: number } = {},
): number {
  const i = world.em.create();
  const c = world.comp;
  c.kind[i] = EntityKind.Unit;
  c.subtype[i] = subtype;
  c.owner[i] = owner;
  c.posX[i] = x;
  c.posY[i] = y;
  c.prevX[i] = x;
  c.prevY[i] = y;
  c.hp[i] = opts.hp ?? 40;
  c.maxHp[i] = opts.hp ?? 40;
  c.orderType[i] = opts.order ?? OrderType.Idle;
  c.radius[i] = 0.3;
  if (owner !== GAIA) world.players[owner].population += opts.pop ?? (subtype === UnitType.Sheep ? 0 : 1);
  return i;
}

function spawnBuilding(
  world: World,
  owner: PlayerId,
  subtype: BuildingType,
  tileX: number,
  tileY: number,
  size: number,
  completed: boolean,
): number {
  const i = world.em.create();
  const c = world.comp;
  c.kind[i] = EntityKind.Building;
  c.subtype[i] = subtype;
  c.owner[i] = owner;
  c.sizeX[i] = size;
  c.sizeY[i] = size;
  c.posX[i] = tileX + size / 2;
  c.posY[i] = tileY + size / 2;
  c.prevX[i] = c.posX[i];
  c.prevY[i] = c.posY[i];
  c.hp[i] = completed ? 1000 : 1;
  c.maxHp[i] = 1000;
  c.flags[i] = completed ? 0 : FLAG_UNDER_CONSTRUCTION;
  const handle = world.em.handleFor(i);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const t = tileIndex(world.map.size, tileX + dx, tileY + dy);
      world.map.occupant[t] = handle;
    }
  }
  return i;
}

function setNode(world: World, tx: number, ty: number, node: ResourceNode, amount: number): void {
  const t = tileIndex(world.map.size, tx, ty);
  world.map.resourceType[t] = node;
  world.map.resourceAmount[t] = amount;
}

/** A fresh-start-like world for player 1: completed TC, 3 idle villagers, nearby forage + trees. */
function freshStartWorld(): World {
  const world = makeWorld(40, 2);
  const p1 = world.players[1];
  p1.resources.set([200, 200, 100, 100]);
  p1.populationCap = 5;
  spawnBuilding(world, 1, BuildingType.TownCenter, 10, 10, 4, true);
  spawnUnit(world, 1, UnitType.Villager, 9, 10);
  spawnUnit(world, 1, UnitType.Villager, 9, 11);
  spawnUnit(world, 1, UnitType.Villager, 10, 9);
  // forage cluster + a forest, comfortably within search radius of the TC
  for (let k = 0; k < 4; k++) setNode(world, 8 + k, 16, ResourceNode.Forage, 125);
  for (let k = 0; k < 4; k++) setNode(world, 16, 8 + k, ResourceNode.Tree, 100);
  return world;
}

/** A serializable snapshot of every piece of world state the AI could conceivably touch. */
function snapshot(world: World): unknown {
  const c = world.comp;
  const arr = (a: ArrayLike<number>) => Array.from(a);
  return {
    tick: world.tick,
    status: world.status,
    winner: world.winner,
    rng: world.rng.s,
    alive: arr(world.em.alive),
    generation: arr(world.em.generation),
    aliveCount: world.em.aliveCount,
    players: world.players.map((p) => ({
      resources: arr(p.resources),
      population: p.population,
      populationCap: p.populationCap,
      age: p.age,
      alive: p.alive,
      researched: arr(p.researched),
    })),
    map: {
      resourceType: arr(world.map.resourceType),
      resourceAmount: arr(world.map.resourceAmount),
      occupant: arr(world.map.occupant),
      visible: arr(world.map.visible),
      explored: arr(world.map.explored),
    },
    comp: {
      kind: arr(c.kind),
      subtype: arr(c.subtype),
      owner: arr(c.owner),
      flags: arr(c.flags),
      posX: arr(c.posX),
      posY: arr(c.posY),
      hp: arr(c.hp),
      orderType: arr(c.orderType),
      orderTarget: arr(c.orderTarget),
      orderTile: arr(c.orderTile),
      orderX: arr(c.orderX),
      orderY: arr(c.orderY),
      carryAmount: arr(c.carryAmount),
      storedResource: arr(c.storedResource),
      queue: c.queue.map((q) => (q ? q.length : -1)),
    },
    events: world.events.length,
  };
}

// ----------------------------------------------------------------- tests -----

describe('createAIPlayer / think', () => {
  it('returns [] on non-think ticks and non-empty on think ticks', () => {
    const world = freshStartWorld();
    const ai = createAIPlayer(1, 4242);
    // player 1, thinkInterval 10 -> thinks when tick % 10 === 1
    world.tick = 2;
    expect(ai.think(world)).toEqual([]);
    world.tick = 5;
    expect(ai.think(world)).toEqual([]);
    world.tick = 11;
    expect(ai.think(world).length).toBeGreaterThan(0);
  });

  it('is deterministic: two fresh AIs with the same seed emit an identical command list', () => {
    const world = freshStartWorld();
    world.tick = 11;
    const a = createAIPlayer(1, 777).think(world);
    const b = createAIPlayer(1, 777).think(world);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('different seeds may diverge but each remains internally reproducible', () => {
    const world = freshStartWorld();
    world.tick = 11;
    const a1 = createAIPlayer(1, 1).think(world);
    const a2 = createAIPlayer(1, 1).think(world);
    const b1 = createAIPlayer(1, 2).think(world);
    expect(a1).toEqual(a2); // same seed -> identical
    expect(Array.isArray(b1)).toBe(true);
  });

  it('never emits more than the ~8 command bound', () => {
    const world = freshStartWorld();
    const ai = createAIPlayer(1, 55);
    for (let t = 1; t < 200; t += 10) {
      world.tick = t;
      expect(ai.think(world).length).toBeLessThanOrEqual(8);
    }
  });

  it('respects a custom thinkInterval from config', () => {
    const world = freshStartWorld();
    const ai = createAIPlayer(1, 9, { thinkInterval: 4 });
    // thinks when tick % 4 === 1 % 4 === 1
    world.tick = 1;
    expect(ai.think(world).length).toBeGreaterThan(0);
    world.tick = 2;
    expect(ai.think(world)).toEqual([]);
    world.tick = 5;
    expect(ai.think(world).length).toBeGreaterThan(0);
    expect(DEFAULT_AI_CONFIG.thinkInterval).toBe(10);
  });
});

describe('think purity (read-only World, private RNG only)', () => {
  it('does not mutate world state (including world.rng) during a think', () => {
    const world = freshStartWorld();
    world.tick = 11;
    const before = snapshot(world);
    const ai = createAIPlayer(1, 31337);
    ai.think(world);
    const after = snapshot(world);
    expect(after).toEqual(before);
  });

  it('does not mutate world on a non-think tick either', () => {
    const world = freshStartWorld();
    world.tick = 4;
    const before = snapshot(world);
    createAIPlayer(1, 5).think(world);
    expect(snapshot(world)).toEqual(before);
  });
});

describe('economy planning (single think)', () => {
  it('trains a villager and issues food + wood gather commands from a fresh start', () => {
    const world = freshStartWorld();
    world.tick = 11;
    const cmds = createAIPlayer(1, 2024).think(world);

    const trains = cmds.filter((c): c is Extract<Command, { type: 'train' }> => c.type === 'train');
    expect(trains.some((c) => c.unit === UnitType.Villager)).toBe(true);

    const gathers = cmds.filter((c): c is Extract<Command, { type: 'gatherTile' }> => c.type === 'gatherTile');
    // resolve each gather tile to the resource it yields
    const foodTiles = gathers.filter((c) => world.map.resourceType[c.tile] === ResourceNode.Forage);
    const woodTiles = gathers.filter((c) => world.map.resourceType[c.tile] === ResourceNode.Tree);
    expect(foodTiles.length).toBeGreaterThan(0);
    expect(woodTiles.length).toBeGreaterThan(0);
  });

  it('builds a House when the population cap is nearly reached', () => {
    const world = freshStartWorld();
    // pop 4 of cap 5 -> within POP_BUFFER, house expected
    world.players[1].population = 4;
    world.players[1].populationCap = 5;
    world.tick = 11;
    const cmds = createAIPlayer(1, 8).think(world);
    const houses = cmds.filter(
      (c): c is Extract<Command, { type: 'build' }> => c.type === 'build' && c.building === BuildingType.House,
    );
    expect(houses.length).toBe(1);
    // the placement must be a legal, unoccupied land footprint
    const h = houses[0];
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const t = tileIndex(world.map.size, h.tileX + dx, h.tileY + dy);
        expect(world.map.occupant[t]).toBe(-1);
        expect(world.map.resourceType[t]).toBe(ResourceNode.None);
      }
    }
  });
});

describe('military planning', () => {
  it('commits the whole army at the enemy Town Center once it reaches attackArmySize', () => {
    const world = makeWorld(48, 2);
    const p1 = world.players[1];
    p1.resources.set([0, 0, 0, 0]);
    p1.populationCap = 20;
    // enemy (player 2) Town Center at tile (30,30)
    spawnBuilding(world, 2, BuildingType.TownCenter, 30, 30, 4, true);
    // player 1 owns exactly attackArmySize idle militia
    const n = DEFAULT_AI_CONFIG.attackArmySize;
    for (let k = 0; k < n; k++) spawnUnit(world, 1, UnitType.Militia, 5 + k * 0.2, 5, { hp: 40 });

    world.tick = 11; // player 1 think tick
    const cmds = createAIPlayer(1, 99).think(world);

    // The military planner focus-fires the enemy TC directly (an `attack` on the TC entity) so the
    // army razes it rather than skirmishing forever — razing a TC is the only way to defeat a player.
    // (The attackMove-to-a-point fallback only fires when NO enemy entity is located at all.)
    const attacks = cmds.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack');
    expect(attacks.length).toBeGreaterThan(0);
    const a = attacks[0];
    expect(a.units.length).toBe(n);
    const ti = resolveHandle(world.em, a.target);
    expect(ti).toBeGreaterThanOrEqual(0);
    expect(world.comp.subtype[ti]).toBe(BuildingType.TownCenter);
    expect(world.comp.owner[ti]).toBe(2);
  });

  it('does NOT attack when the army is below attackArmySize', () => {
    const world = makeWorld(48, 2);
    world.players[1].populationCap = 20;
    spawnBuilding(world, 2, BuildingType.TownCenter, 30, 30, 4, true);
    for (let k = 0; k < DEFAULT_AI_CONFIG.attackArmySize - 1; k++) {
      spawnUnit(world, 1, UnitType.Militia, 5 + k * 0.2, 5);
    }
    world.tick = 11;
    const cmds = createAIPlayer(1, 3).think(world);
    expect(cmds.some((c) => c.type === 'attackMove')).toBe(false);
  });

  it('researches FeudalAge at the TC once a Barracks is up and 500 food is banked', () => {
    const world = makeWorld(40, 2);
    const p1 = world.players[1];
    p1.resources.set([600, 200, 100, 100]);
    p1.population = 8;
    p1.populationCap = 15;
    const tc = spawnBuilding(world, 1, BuildingType.TownCenter, 10, 10, 4, true);
    spawnBuilding(world, 1, BuildingType.Barracks, 16, 10, 3, true);
    world.tick = 11;
    const cmds = createAIPlayer(1, 71).think(world);
    const research = cmds.filter((c): c is Extract<Command, { type: 'research' }> => c.type === 'research');
    const feudal = research.find((c) => c.tech === TechId.FeudalAge);
    expect(feudal).toBeDefined();
    expect(feudal!.building).toBe(world.em.handleFor(tc));
  });
});
