import { describe, it, expect } from 'vitest';
import { hashWorld } from '../../src/core/hash';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores, resetEntityComponents } from '../../src/core/components';
import { createSpatialGrid } from '../../src/core/spatial';
import { createRng } from '../../src/shared/rng';
import { RESOURCE_COUNT, TECH_COUNT, Age, CivId, GAIA, MatchStatus, EntityKind, OrderType } from '../../src/shared/enums';
import { STARTING_RESOURCES } from '../../src/shared/constants';
import type { World, PlayerState, TileMap } from '../../src/shared/world';

const CAP = 64;
const MAP_SIZE = 16;

function makeTileMap(size: number): TileMap {
  const occupant = new Int32Array(size * size);
  occupant.fill(-1);
  return {
    size,
    terrain: new Uint8Array(size * size),
    resourceType: new Uint8Array(size * size),
    resourceAmount: new Float32Array(size * size),
    occupant,
    visible: new Uint8Array(size * size),
    explored: new Uint8Array(size * size),
  };
}

function makePlayer(id: number, civ: CivId, isAI: boolean, alive: boolean): PlayerState {
  const resources = new Float32Array(RESOURCE_COUNT);
  if (alive) for (let i = 0; i < RESOURCE_COUNT; i++) resources[i] = STARTING_RESOURCES[i];
  return {
    id,
    civ,
    isAI,
    alive,
    resources,
    population: 0,
    populationCap: 5,
    age: Age.Dark,
    researched: new Uint8Array(TECH_COUNT),
    statsVersion: 0,
  };
}

function makeWorld(): World {
  const em = createEntityManager(CAP);
  const comp = createComponentStores(CAP);
  const grid = createSpatialGrid(MAP_SIZE, 4);
  return {
    tick: 0,
    seed: 12345,
    rng: createRng(12345),
    mapSize: MAP_SIZE,
    em,
    comp,
    map: makeTileMap(MAP_SIZE),
    grid,
    pathCache: { version: 0, entries: new Map(), hits: 0, misses: 0 },
    players: [
      makePlayer(GAIA, CivId.Britons, false, false),
      makePlayer(1, CivId.Britons, false, true),
      makePlayer(2, CivId.Franks, true, true),
    ],
    events: [],
    status: MatchStatus.Running,
    winner: -1,
  };
}

/** Spawn a Unit at index with a set of representative component values. */
function spawnUnit(w: World, owner: number, x: number, y: number, hp: number): number {
  const i = w.em.create();
  w.comp.kind[i] = EntityKind.Unit;
  w.comp.subtype[i] = 0;
  w.comp.owner[i] = owner;
  w.comp.posX[i] = x;
  w.comp.posY[i] = y;
  w.comp.hp[i] = hp;
  w.comp.maxHp[i] = hp;
  w.comp.orderType[i] = OrderType.Idle;
  return i;
}

describe('hashWorld', () => {
  it('is stable across repeated calls for the same state', () => {
    const w = makeWorld();
    spawnUnit(w, 1, 3.5, 4.5, 25);
    spawnUnit(w, 2, 10.5, 11.5, 45);
    const a = hashWorld(w);
    const b = hashWorld(w);
    expect(a).toBe(b);
    // A freshly rebuilt identical world hashes the same.
    const w2 = makeWorld();
    spawnUnit(w2, 1, 3.5, 4.5, 25);
    spawnUnit(w2, 2, 10.5, 11.5, 45);
    expect(hashWorld(w2)).toBe(a);
  });

  it('returns an unsigned 32-bit integer', () => {
    const w = makeWorld();
    spawnUnit(w, 1, 1.5, 1.5, 25);
    const h = hashWorld(w);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('changes when a single hp bit is flipped', () => {
    const w = makeWorld();
    const i = spawnUnit(w, 1, 2.5, 2.5, 100);
    const before = hashWorld(w);
    // Flip the least-significant mantissa bit of the stored float32 value.
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    f[0] = w.comp.hp[i];
    u[0] = u[0] ^ 1;
    w.comp.hp[i] = f[0];
    expect(hashWorld(w)).not.toBe(before);
  });

  it('changes when tick / position / order / owner change', () => {
    const w = makeWorld();
    const i = spawnUnit(w, 1, 5.5, 5.5, 40);
    const base = hashWorld(w);

    w.tick = 1;
    const afterTick = hashWorld(w);
    expect(afterTick).not.toBe(base);
    w.tick = 0;

    w.comp.posX[i] = 5.5001;
    expect(hashWorld(w)).not.toBe(base);
    w.comp.posX[i] = 5.5;
    expect(hashWorld(w)).toBe(base); // fully restored

    w.comp.orderType[i] = OrderType.Move;
    expect(hashWorld(w)).not.toBe(base);
    w.comp.orderType[i] = OrderType.Idle;

    w.comp.owner[i] = 2;
    expect(hashWorld(w)).not.toBe(base);
  });

  it('changes when per-player resources / age / population / researched change', () => {
    const w = makeWorld();
    spawnUnit(w, 1, 1.5, 1.5, 25);
    const base = hashWorld(w);

    w.players[1].resources[0] += 1;
    expect(hashWorld(w)).not.toBe(base);
    w.players[1].resources[0] -= 1;
    expect(hashWorld(w)).toBe(base);

    w.players[1].age = Age.Feudal;
    expect(hashWorld(w)).not.toBe(base);
    w.players[1].age = Age.Dark;

    w.players[1].population = 3;
    expect(hashWorld(w)).not.toBe(base);
    w.players[1].population = 0;

    w.players[2].researched[0] = 1;
    expect(hashWorld(w)).not.toBe(base);
    w.players[2].researched[0] = 0;
    expect(hashWorld(w)).toBe(base);
  });

  it('destroy + resetEntityComponents restores the pre-spawn hash', () => {
    const w = makeWorld();
    const empty = hashWorld(w);

    const i = spawnUnit(w, 1, 7.5, 8.5, 55);
    expect(hashWorld(w)).not.toBe(empty);

    w.em.destroy(i);
    resetEntityComponents(w.comp, i);
    expect(hashWorld(w)).toBe(empty);
  });

  it('is insensitive to a dead slot that was reset (recycle stability)', () => {
    const w = makeWorld();
    const a = spawnUnit(w, 1, 2.5, 3.5, 30);
    const snapshot = hashWorld(w);

    // Spawn + destroy + reset another entity: must not perturb the hash of the survivor world.
    const b = spawnUnit(w, 2, 9.5, 9.5, 45);
    w.em.destroy(b);
    resetEntityComponents(w.comp, b);
    expect(hashWorld(w)).toBe(snapshot);
    expect(w.em.isAlive(a)).toBe(true);
  });
});
