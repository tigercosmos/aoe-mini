import { describe, it, expect, vi } from 'vitest';

// T4 sim modules are not written yet; mock them with contract-faithful fakes so
// the combat/projectile systems can be exercised on real core/map/content.
vi.mock('../../src/sim/movement', () => ({
  requestPath: (world: any, index: number, gx: number, gy: number): boolean => {
    world.comp.path[index] = Uint16Array.of(Math.floor(gy) * world.map.size + Math.floor(gx));
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
  spawnUnit: (): number => -1,
  damageEntity: (world: any, ti: number, _ah: number, amount: number, isPierce: boolean, bonus: number): void => {
    const c = world.comp;
    const armor = isPierce ? c.pierceArmor[ti] : c.meleeArmor[ti];
    c.hp[ti] -= Math.max(1, Math.max(0, amount - armor) + bonus);
    world.__dmg.push({ ti, amount, isPierce, bonus });
  },
  completeConstruction: (): void => {},
  findDropOff: (): number => -1,
  recomputePopCap: (): void => {},
}));

import { combatSystem, spawnProjectile } from '../../src/systems/combat';
import { projectileSystem } from '../../src/systems/projectile';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores } from '../../src/core/components';
import { createSpatialGrid } from '../../src/core/spatial';
import { createTileMap } from '../../src/map/tilemap';
import { createPathCache } from '../../src/map/pathcache';
import { resolveUnitStats, resolveBuildingStats } from '../../src/content/stats';
import type { World } from '../../src/shared/world';
import { resolveHandle } from '../../src/shared/world';
import {
  EntityKind,
  OrderType,
  UnitType,
  BuildingType,
  ProjectileType,
  Age,
  CivId,
  GAIA,
  MatchStatus,
  RESOURCE_COUNT,
  TECH_COUNT,
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

function makeWorld(size = 32): any {
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
    players: [
      makePlayer(GAIA, CivId.Britons, false),
      makePlayer(1, CivId.Britons, true),
      makePlayer(2, CivId.Britons, true),
    ],
    events: [],
    status: MatchStatus.Running,
    winner: -1,
    __dmg: [],
  };
  return world;
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
  c.meleeArmor[i] = rs.meleeArmor;
  c.pierceArmor[i] = rs.pierceArmor;
  c.los[i] = rs.los;
  c.orderType[i] = OrderType.Idle;
  world.players[owner].population += rs.popCost;
  return i;
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
  c.prevX[i] = c.posX[i];
  c.prevY[i] = c.posY[i];
  c.maxHp[i] = bs.hp;
  c.hp[i] = bs.hp;
  c.attack[i] = bs.attack;
  c.attackRange[i] = bs.attackRange;
  c.attackRateTicks[i] = bs.attackRateTicks;
  c.los[i] = bs.los;
  c.radius[i] = 0;
  c.flags[i] = 0; // completed
  c.orderType[i] = OrderType.Idle;
  return i;
}

function findProjectile(world: any): number {
  for (let i = 0; i < world.comp.capacity; i++) {
    if (world.em.alive[i] === 1 && world.comp.kind[i] === EntityKind.Projectile) return i;
  }
  return -1;
}

function combatN(world: any, n: number): void {
  for (let k = 0; k < n; k++) {
    combatSystem(world);
    world.tick++;
  }
}

describe('combatSystem melee', () => {
  it('Militia hits an enemy Militia for 4 every 40 ticks', () => {
    const world = makeWorld();
    const a = addUnit(world, 1, UnitType.Militia, 5, 5);
    const b = addUnit(world, 2, UnitType.Militia, 5.5, 5); // 0.5 apart => in melee range
    world.comp.orderType[a] = OrderType.AttackTarget;
    world.comp.orderTarget[a] = world.em.handleFor(b);
    // No grid.rebuild -> b's Idle auto-acquire finds nothing, so it never retaliates.

    combatN(world, 1);
    expect(world.comp.hp[b]).toBe(36);
    combatN(world, 39); // still on cooldown
    expect(world.comp.hp[b]).toBe(36);
    combatN(world, 1); // 41st pass -> second swing
    expect(world.comp.hp[b]).toBe(32);
  });

  it('Spearman deals 3-2+15 = 16 to a Knight (Cavalry bonus, not reduced by armor)', () => {
    const world = makeWorld();
    const s = addUnit(world, 1, UnitType.Spearman, 5, 5);
    const k = addUnit(world, 2, UnitType.Knight, 5.5, 5);
    const knightHp = world.comp.hp[k];
    world.comp.orderType[s] = OrderType.AttackTarget;
    world.comp.orderTarget[s] = world.em.handleFor(k);

    combatN(world, 1);
    expect(world.comp.hp[k]).toBe(knightHp - 16);
  });
});

describe('combatSystem ranged + projectileSystem', () => {
  it('Archer fires an Arrow that pierces the target on impact', () => {
    const world = makeWorld();
    const ar = addUnit(world, 1, UnitType.Archer, 5, 5);
    const tgt = addUnit(world, 2, UnitType.Militia, 9, 5); // dist 4 == attackRange
    world.comp.orderType[ar] = OrderType.AttackTarget;
    world.comp.orderTarget[ar] = world.em.handleFor(tgt);

    combatN(world, 1);
    const p = findProjectile(world);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(world.comp.subtype[p]).toBe(ProjectileType.Arrow);
    expect(world.comp.projDamage[p]).toBe(4);
    expect(resolveHandle(world.em, world.comp.projSource[p])).toBe(ar);
    expect(world.events.some((e: any) => e.type === 'projectileFired')).toBe(true);

    // Fly to impact (4 tiles / 0.35 per tick ~= 12 ticks).
    for (let t = 0; t < 20; t++) projectileSystem(world);
    // Militia pierceArmor 1 => damage max(1, 4-1) = 3.
    expect(world.comp.hp[tgt]).toBe(37);
    expect(world.comp.hp[p]).toBe(0); // marked dead for deathSystem
  });

  it('a projectile fizzles (no damage) when its target dies mid-flight', () => {
    const world = makeWorld();
    const ar = addUnit(world, 1, UnitType.Archer, 5, 5);
    const tgt = addUnit(world, 2, UnitType.Militia, 9, 5);
    world.comp.orderType[ar] = OrderType.AttackTarget;
    world.comp.orderTarget[ar] = world.em.handleFor(tgt);

    combatN(world, 1);
    const p = findProjectile(world);
    expect(p).toBeGreaterThanOrEqual(0);
    world.__dmg.length = 0;

    // Target dies before the arrow lands.
    world.em.destroy(tgt);
    projectileSystem(world);

    expect(world.comp.hp[p]).toBe(0);
    expect(world.__dmg.length).toBe(0); // no damage applied
  });

  it('a Town Center auto-acquires and fires at an enemy within range', () => {
    const world = makeWorld();
    const tc = addBuilding(world, 1, BuildingType.TownCenter, 5, 5); // center (7,7)
    const enemy = addUnit(world, 2, UnitType.Militia, 12, 7); // dist 5 <= range 6, within LOS 8
    world.grid.rebuild(world.em, world.comp);

    combatN(world, 1);
    const p = findProjectile(world);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(world.comp.projDamage[p]).toBe(5); // TC attack 5, no bonus
    expect(world.comp.subtype[p]).toBe(ProjectileType.Arrow);
    expect(resolveHandle(world.em, world.comp.projSource[p])).toBe(tc);
    expect(resolveHandle(world.em, world.comp.orderTarget[tc])).toBe(enemy);
  });
});

describe('combatSystem acquisition', () => {
  it('an idle military unit auto-acquires the nearest enemy in LOS and commits to AttackTarget', () => {
    const world = makeWorld();
    const m = addUnit(world, 1, UnitType.Militia, 10, 10);
    const near = addUnit(world, 2, UnitType.Militia, 11, 10); // dist 1, in LOS 4
    const far = addUnit(world, 2, UnitType.Militia, 12.5, 10); // dist 2.5, also in LOS
    world.grid.rebuild(world.em, world.comp);

    combatN(world, 1);
    expect(world.comp.orderType[m]).toBe(OrderType.AttackTarget);
    expect(resolveHandle(world.em, world.comp.orderTarget[m])).toBe(near);
    void far;
  });
});
