import { describe, it, expect, vi } from 'vitest';

// The sim engine (T4) is not written yet; mock the two sim modules T5 systems import
// with contract-faithful fakes so these unit tests run fully standalone on the real
// core/map/content modules. (Vitest can mock not-yet-existing module paths.)
vi.mock('../../src/sim/movement', () => ({
  requestPath: (world: any, index: number, gx: number, gy: number): boolean => {
    const t = Math.floor(gy) * world.map.size + Math.floor(gx);
    world.comp.path[index] = Uint16Array.of(t);
    world.comp.pathStep[index] = 0;
    world.comp.pathVersion[index] = world.pathCache.version;
    return true;
  },
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
    world.players[owner].population += 1;
    world.__spawns.push({ owner, unit, x, y });
    return ((world.em.generation[i] << 12) | i) >>> 0;
  },
  damageEntity: (world: any, ti: number, _ah: number, amount: number, isPierce: boolean, bonus: number): void => {
    const c = world.comp;
    const armor = isPierce ? c.pierceArmor[ti] : c.meleeArmor[ti];
    c.hp[ti] -= Math.max(1, Math.max(0, amount - armor) + bonus);
  },
  completeConstruction: (world: any, index: number): void => {
    const c = world.comp;
    c.flags[index] &= ~1; // clear FLAG_UNDER_CONSTRUCTION
    c.hp[index] = c.maxHp[index];
    world.events.push({
      type: 'constructionComplete',
      entity: ((world.em.generation[index] << 12) | index) >>> 0,
      owner: c.owner[index],
      building: c.subtype[index],
    });
  },
  findDropOff: (world: any, vi2: number, res: number): number => {
    const c = world.comp;
    const em = world.em;
    const dm = world.__dropMask;
    const owner = c.owner[vi2];
    let best = -1;
    let bestD = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < c.capacity; i++) {
      if (em.alive[i] !== 1) continue;
      if (c.kind[i] !== 1) continue; // Building
      if (c.owner[i] !== owner) continue;
      if ((c.flags[i] & 1) !== 0) continue; // under construction
      if ((dm[i] & (1 << res)) === 0) continue;
      const dx = c.posX[i] - c.posX[vi2];
      const dy = c.posY[i] - c.posY[vi2];
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && (bestIdx === -1 || i < bestIdx))) {
        bestD = d;
        bestIdx = i;
        best = ((em.generation[i] << 12) | i) >>> 0;
      }
    }
    return best;
  },
  recomputePopCap: (): void => {},
}));

import { villagerSystem } from '../../src/systems/villager';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores } from '../../src/core/components';
import { createSpatialGrid } from '../../src/core/spatial';
import { createTileMap } from '../../src/map/tilemap';
import { createPathCache } from '../../src/map/pathcache';
import { resolveUnitStats, resolveBuildingStats } from '../../src/content/stats';
import type { World } from '../../src/shared/world';
import {
  EntityKind,
  OrderType,
  UnitType,
  BuildingType,
  ResourceNode,
  Resource,
  Age,
  CivId,
  GAIA,
  MatchStatus,
  RESOURCE_COUNT,
  TECH_COUNT,
  FLAG_UNDER_CONSTRUCTION,
} from '../../src/shared/enums';
import { tileIndex, TREE_WOOD } from '../../src/shared/constants';

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

function makeWorld(size = 24): World {
  const cap = 64;
  const em = createEntityManager(cap);
  const comp = createComponentStores(cap);
  const map = createTileMap(size);
  const grid = createSpatialGrid(size);
  const pathCache = createPathCache();
  const players = [makePlayer(GAIA, CivId.Britons, false), makePlayer(1, CivId.Britons, true)];
  const world: any = {
    tick: 0,
    seed: 1,
    rng: { s: 1 },
    mapSize: size,
    em,
    comp,
    map,
    grid,
    pathCache,
    players,
    events: [],
    status: MatchStatus.Running,
    winner: -1,
    __spawns: [],
    __dropMask: new Int32Array(cap),
  };
  return world as World;
}

function addUnit(world: any, owner: number, unit: UnitType, x: number, y: number): number {
  const c = world.comp;
  const i = world.em.create();
  const rs = resolveUnitStats(world, owner, unit);
  c.kind[i] = EntityKind.Unit;
  c.subtype[i] = unit;
  c.owner[i] = owner;
  c.posX[i] = x;
  c.posY[i] = y;
  c.prevX[i] = x;
  c.prevY[i] = y;
  c.radius[i] = rs.radius;
  c.speed[i] = rs.speedPerTick;
  c.hp[i] = rs.hp;
  c.maxHp[i] = rs.hp;
  c.attack[i] = rs.attack;
  c.attackRange[i] = rs.attackRange;
  c.attackRateTicks[i] = rs.attackRateTicks;
  c.los[i] = rs.los;
  c.orderType[i] = OrderType.Idle;
  world.players[owner].population += rs.popCost;
  return i;
}

function addBuilding(world: any, owner: number, b: BuildingType, tx: number, ty: number, completed: boolean): number {
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
  c.prevX[i] = c.posX[i];
  c.prevY[i] = c.posY[i];
  c.maxHp[i] = bs.hp;
  c.hp[i] = completed ? bs.hp : 1;
  c.los[i] = bs.los;
  c.radius[i] = 0;
  c.flags[i] = completed ? 0 : FLAG_UNDER_CONSTRUCTION;
  c.storedResource[i] = completed ? bs.storesFood : 0;
  c.buildProgress[i] = 0;
  c.orderType[i] = OrderType.Idle;
  world.__dropMask[i] = bs.dropOff;
  for (let dy = 0; dy < bs.sizeY; dy++) {
    for (let dx = 0; dx < bs.sizeX; dx++) {
      world.map.occupant[tileIndex(world.map.size, tx + dx, ty + dy)] = world.em.handleFor(i);
    }
  }
  return i;
}

function run(world: any, n: number): void {
  for (let k = 0; k < n; k++) {
    villagerSystem(world);
    world.tick++;
  }
}

describe('villagerSystem', () => {
  it('gathers wood from a tree, deposits at the lumber camp, and resumes the same tree', () => {
    const world: any = makeWorld();
    const size = world.map.size;
    const treeTile = tileIndex(size, 5, 5);
    world.map.resourceType[treeTile] = ResourceNode.Tree;
    world.map.resourceAmount[treeTile] = TREE_WOOD;

    // Villager sits in gather range of the tree AND deposit range of the camp,
    // so the full cycle exercises without needing movementSystem.
    const v = addUnit(world, 1, UnitType.Villager, 5.5, 6.5);
    addBuilding(world, 1, BuildingType.LumberCamp, 5, 7, true);
    world.comp.orderType[v] = OrderType.GatherTile;
    world.comp.orderTile[v] = treeTile;

    run(world, 520); // >10 wood / 0.0195 per tick

    expect(world.players[1].resources[Resource.Wood]).toBeGreaterThanOrEqual(10);
    expect(world.map.resourceAmount[treeTile]).toBeLessThan(TREE_WOOD);
    // Back on the same tree after the trip.
    expect(world.comp.orderType[v]).toBe(OrderType.GatherTile);
    expect(world.comp.orderTile[v]).toBe(treeTile);
  });

  it('auto-retargets an adjacent tree when the node depletes', () => {
    const world: any = makeWorld();
    const size = world.map.size;
    const treeTile = tileIndex(size, 5, 5);
    const nextTree = tileIndex(size, 6, 5);
    world.map.resourceType[treeTile] = ResourceNode.Tree;
    world.map.resourceAmount[treeTile] = 4; // small -> depletes quickly
    world.map.resourceType[nextTree] = ResourceNode.Tree;
    world.map.resourceAmount[nextTree] = TREE_WOOD;

    const v = addUnit(world, 1, UnitType.Villager, 5.5, 6.5);
    world.comp.orderType[v] = OrderType.GatherTile;
    world.comp.orderTile[v] = treeTile;

    run(world, 300);

    expect(world.map.resourceType[treeTile]).toBe(ResourceNode.None);
    expect(world.events.some((e: any) => e.type === 'resourceNodeDepleted' && e.tile === treeTile)).toBe(true);
    expect(world.comp.orderTile[v]).toBe(nextTree);
  });

  it('eats a sheep/farm to zero, which sets its hp to 0 for the death system', () => {
    const world: any = makeWorld();
    const farm = addBuilding(world, 1, BuildingType.Farm, 5, 5, true);
    world.comp.storedResource[farm] = 3; // deplete quickly
    const v = addUnit(world, 1, UnitType.Villager, 6.0, 7.5); // within 2.25 of center (6,6)
    world.comp.orderType[v] = OrderType.GatherEntity;
    world.comp.orderTarget[v] = world.em.handleFor(farm);

    run(world, 260);

    expect(world.comp.storedResource[farm]).toBe(0);
    expect(world.comp.hp[farm]).toBe(0);
    expect(world.comp.orderTarget[v]).toBe(-1);
  });

  it('builds a House: two villagers finish it in ~250 ticks, hp ramps, and it completes', () => {
    const world: any = makeWorld();
    const house = addBuilding(world, 1, BuildingType.House, 5, 5, false); // 2x2, center (6,6)
    const maxHp = world.comp.maxHp[house];
    const a = addUnit(world, 1, UnitType.Villager, 5.5, 7.5);
    const b = addUnit(world, 1, UnitType.Villager, 6.5, 7.5);
    for (const u of [a, b]) {
      world.comp.orderType[u] = OrderType.Build;
      world.comp.orderTarget[u] = world.em.handleFor(house);
    }

    // Not done at 240 ticks (480 builder-ticks < 500), done by 260.
    run(world, 240);
    expect(world.comp.flags[house] & FLAG_UNDER_CONSTRUCTION).toBe(FLAG_UNDER_CONSTRUCTION);
    expect(world.comp.hp[house]).toBeGreaterThan(1);
    expect(world.comp.hp[house]).toBeLessThan(maxHp);

    run(world, 20);
    expect(world.comp.flags[house] & FLAG_UNDER_CONSTRUCTION).toBe(0);
    expect(world.comp.hp[house]).toBe(maxHp);
    expect(world.events.some((e: any) => e.type === 'constructionComplete')).toBe(true);
    expect(world.comp.orderType[a]).toBe(OrderType.Idle);
    expect(world.comp.orderType[b]).toBe(OrderType.Idle);
  });
});
