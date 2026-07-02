import { describe, it, expect } from 'vitest';
import {
  Age,
  BuildingType,
  CivId,
  EntityKind,
  GatherSource,
  RESOURCE_COUNT,
  TECH_COUNT,
  TechId,
  UnitType,
} from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { PlayerState, World } from '../../src/shared/world';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores } from '../../src/core/components';
import {
  activeModifiers,
  applyTechEffects,
  canTrain,
  carryCapacity,
  gatherRatePerTick,
  resolveBuildingStats,
  resolveCost,
  resolveUnitStats,
} from '../../src/content/stats';

function makePlayer(id: PlayerId, civ: CivId, age: Age): PlayerState {
  return {
    id,
    civ,
    isAI: false,
    alive: true,
    resources: new Float32Array(RESOURCE_COUNT),
    population: 0,
    populationCap: 0,
    age,
    researched: new Uint8Array(TECH_COUNT),
    statsVersion: 0,
  };
}

const CAP = 64;

/** A World with real T1 entity manager + component stores and the given player civs (index 1..). */
function makeWorld(playerCivs: CivId[], age: Age): World {
  const em = createEntityManager(CAP);
  const comp = createComponentStores(CAP);
  const players: PlayerState[] = [makePlayer(0, CivId.Britons, Age.Dark)];
  for (let i = 0; i < playerCivs.length; i++) {
    players.push(makePlayer(i + 1, playerCivs[i], age));
  }
  return { em, comp, players } as unknown as World;
}

function spawnUnit(world: World, owner: PlayerId, subtype: UnitType, hp: number, maxHp = hp): number {
  const i = world.em.create();
  world.comp.kind[i] = EntityKind.Unit;
  world.comp.subtype[i] = subtype;
  world.comp.owner[i] = owner;
  world.comp.hp[i] = hp;
  world.comp.maxHp[i] = maxHp;
  return i;
}

/** Set a researched flag by hand and invalidate the resolver memo (as applyTechEffects would). */
function research(world: World, player: PlayerId, tech: TechId): void {
  world.players[player].researched[tech] = 1;
  world.players[player].statsVersion++;
}

describe('resolveUnitStats — civ bonus golden values', () => {
  it('Briton archer-class units get +1 range (Archer 5, Longbowman 6)', () => {
    const w = makeWorld([CivId.Britons], Age.Castle);
    expect(resolveUnitStats(w, 1, UnitType.Archer).attackRange).toBe(5);
    expect(resolveUnitStats(w, 1, UnitType.Longbowman).attackRange).toBe(6);
  });

  it('Franks Knight HP is 120 (+20%)', () => {
    const w = makeWorld([CivId.Franks], Age.Castle);
    expect(resolveUnitStats(w, 1, UnitType.Knight).hp).toBeCloseTo(120, 6);
  });

  it('Mongol Mangudai attack rate 33.6 and military train times -10% (Militia 378, Mangudai 468)', () => {
    const w = makeWorld([CivId.Mongols], Age.Castle);
    expect(resolveUnitStats(w, 1, UnitType.Mangudai).attackRateTicks).toBeCloseTo(33.6, 6);
    expect(resolveUnitStats(w, 1, UnitType.Militia).trainTicks).toBeCloseTo(378, 6);
    expect(resolveUnitStats(w, 1, UnitType.Mangudai).trainTicks).toBeCloseTo(468, 6);
  });

  it('non-Mongol civ keeps base attack rate / train time', () => {
    const w = makeWorld([CivId.Britons], Age.Castle);
    expect(resolveUnitStats(w, 1, UnitType.Mangudai).attackRateTicks).toBe(42);
    expect(resolveUnitStats(w, 1, UnitType.Militia).trainTicks).toBe(420);
  });

  it('speedPerTick divides tiles/sec by TICK_RATE', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    expect(resolveUnitStats(w, 1, UnitType.Villager).speedPerTick).toBeCloseTo(0.05, 12);
  });
});

describe('resolveCost — civ cost discounts (ceil per resource)', () => {
  it('Briton Town Center costs 138W + 100S (half wood)', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    expect(resolveCost(w, 1, { building: BuildingType.TownCenter })).toEqual({
      food: 0,
      wood: 138,
      gold: 0,
      stone: 100,
    });
  });

  it('Franks Castle costs 488S (25% off, all resources)', () => {
    const w = makeWorld([CivId.Franks], Age.Castle);
    const c = resolveCost(w, 1, { building: BuildingType.Castle });
    expect(c).toEqual({ food: 0, wood: 0, gold: 0, stone: 488 });
  });

  it('a civ without the discount pays the base cost', () => {
    const w = makeWorld([CivId.Mongols], Age.Castle);
    expect(resolveCost(w, 1, { building: BuildingType.TownCenter })).toEqual({
      food: 0,
      wood: 275,
      gold: 0,
      stone: 100,
    });
    expect(resolveCost(w, 1, { building: BuildingType.Castle }).stone).toBe(650);
  });
});

describe('resolveBuildingStats', () => {
  it('copies base stats and folds the cost discount into .cost', () => {
    const w = makeWorld([CivId.Franks], Age.Castle);
    const tc = resolveBuildingStats(w, 1, BuildingType.TownCenter);
    expect(tc.hp).toBe(2400);
    expect(tc.sizeX).toBe(4);
    expect(tc.attack).toBe(5);
    expect(tc.popProvided).toBe(5);
    // Franks discount targets the Castle, not the TC.
    expect(tc.cost).toEqual({ food: 0, wood: 275, gold: 0, stone: 100 });
    const castle = resolveBuildingStats(w, 1, BuildingType.Castle);
    expect(castle.cost.stone).toBe(488);
    expect(castle.hp).toBe(4800);
  });
});

describe('resolveUnitStats — researched tech effects (add-then-mul, stacking)', () => {
  it('Forging gives Infantry +1 attack (Militia 4 -> 5)', () => {
    const w = makeWorld([CivId.Britons], Age.Feudal);
    expect(resolveUnitStats(w, 1, UnitType.Militia).attack).toBe(4);
    research(w, 1, TechId.Forging);
    expect(resolveUnitStats(w, 1, UnitType.Militia).attack).toBe(5);
  });

  it('Fletching gives Archer +1 attack and +1 range; stacks with Briton range bonus', () => {
    const wf = makeWorld([CivId.Franks], Age.Feudal);
    research(wf, 1, TechId.Fletching);
    const a = resolveUnitStats(wf, 1, UnitType.Archer);
    expect(a.attack).toBe(5);
    expect(a.attackRange).toBe(5);

    const wb = makeWorld([CivId.Britons], Age.Feudal);
    research(wb, 1, TechId.Fletching);
    const ab = resolveUnitStats(wb, 1, UnitType.Archer);
    expect(ab.attack).toBe(5);
    expect(ab.attackRange).toBe(6); // 4 base + 1 Fletching + 1 Briton
  });

  it('memoizes per (player, statsVersion) and recomputes on version bump', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    const r1 = resolveUnitStats(w, 1, UnitType.Villager);
    const r2 = resolveUnitStats(w, 1, UnitType.Villager);
    expect(r2).toBe(r1); // same cached object
    research(w, 1, TechId.Loom);
    const r3 = resolveUnitStats(w, 1, UnitType.Villager);
    expect(r3).not.toBe(r1);
    expect(r3.hp).toBeCloseTo(40, 6); // 25 + 15
  });
});

describe('carryCapacity + gatherRatePerTick', () => {
  it('base carry is 10; Wheelbarrow raises it to 12 (floor(10*1.25))', () => {
    const w = makeWorld([CivId.Franks], Age.Feudal);
    expect(carryCapacity(w, 1)).toBe(10);
    research(w, 1, TechId.Wheelbarrow);
    expect(carryCapacity(w, 1)).toBe(12);
  });

  it('Briton shepherds gather sheep 25% faster; Franks foragers 25% faster', () => {
    const wb = makeWorld([CivId.Britons], Age.Dark);
    const wf = makeWorld([CivId.Franks], Age.Dark);
    // Britons boost sheep, not forage; Franks boost forage, not sheep.
    expect(gatherRatePerTick(wb, 1, GatherSource.Sheep)).toBeCloseTo(
      gatherRatePerTick(wf, 1, GatherSource.Sheep) * 1.25,
      12,
    );
    expect(gatherRatePerTick(wf, 1, GatherSource.Forage)).toBeCloseTo((0.31 / 20) * 1.25, 12);
    // Wood is unaffected for both.
    expect(gatherRatePerTick(wb, 1, GatherSource.Wood)).toBeCloseTo(0.39 / 20, 12);
  });
});

describe('canTrain / canResearch / canBuildBuilding gates', () => {
  it('respects age and tech gates', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    // Knight needs Castle age.
    expect(canTrain(w, 1, BuildingType.Stable, UnitType.Knight)).toBe(false);
    // Villager trainable at TC in Dark.
    expect(canTrain(w, 1, BuildingType.TownCenter, UnitType.Villager)).toBe(true);
    // Man-at-Arms needs the upgrade tech even in Feudal.
    w.players[1].age = Age.Feudal;
    w.players[1].statsVersion++;
    expect(canTrain(w, 1, BuildingType.Barracks, UnitType.ManAtArms)).toBe(false);
    expect(canTrain(w, 1, BuildingType.Barracks, UnitType.Militia)).toBe(true);
  });
});

describe('activeModifiers ordering + immutability', () => {
  it('civ bonuses first (3), then researched tech effects', () => {
    const w = makeWorld([CivId.Britons], Age.Feudal);
    research(w, 1, TechId.Forging); // 1 effect
    const mods = activeModifiers(w, 1);
    expect(mods.length).toBe(3 + 1);
    // returned array is a copy: mutating it does not corrupt the cache
    mods.length = 0;
    expect(activeModifiers(w, 1).length).toBe(4);
  });
});

describe('applyTechEffects — live entity patching', () => {
  it('ManAtArmsUpgrade converts live Militia (subtype + hp/maxHp) and re-gates training', () => {
    const w = makeWorld([CivId.Britons], Age.Feudal);
    const i = spawnUnit(w, 1, UnitType.Militia, 40);
    applyTechEffects(w, 1, TechId.ManAtArmsUpgrade);
    expect(w.comp.subtype[i]).toBe(UnitType.ManAtArms);
    expect(w.comp.hp[i]).toBeCloseTo(45, 6);
    expect(w.comp.maxHp[i]).toBeCloseTo(45, 6);
    expect(w.players[1].researched[TechId.ManAtArmsUpgrade]).toBe(1);
    expect(canTrain(w, 1, BuildingType.Barracks, UnitType.Militia)).toBe(false);
    expect(canTrain(w, 1, BuildingType.Barracks, UnitType.ManAtArms)).toBe(true);
  });

  it('Loom adds +15 HP to a live Villager (maxHp scales, damage preserved)', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    const full = spawnUnit(w, 1, UnitType.Villager, 25);
    const hurt = spawnUnit(w, 1, UnitType.Villager, 20, 25); // took 5 damage
    applyTechEffects(w, 1, TechId.Loom);
    expect(w.comp.hp[full]).toBeCloseTo(40, 6);
    expect(w.comp.maxHp[full]).toBeCloseTo(40, 6);
    expect(w.comp.hp[hurt]).toBeCloseTo(35, 6); // 20 + 15 delta
    expect(w.comp.maxHp[hurt]).toBeCloseTo(40, 6);
    expect(w.comp.meleeArmor[full]).toBeCloseTo(1, 6);
    expect(w.comp.pierceArmor[full]).toBeCloseTo(1, 6);
  });

  it('only patches entities owned by the given player', () => {
    const w = makeWorld([CivId.Britons, CivId.Britons], Age.Dark);
    const mine = spawnUnit(w, 1, UnitType.Villager, 25);
    const theirs = spawnUnit(w, 2, UnitType.Villager, 25);
    applyTechEffects(w, 1, TechId.Loom);
    expect(w.comp.hp[mine]).toBeCloseTo(40, 6);
    expect(w.comp.hp[theirs]).toBeCloseTo(25, 6); // untouched
    expect(w.comp.maxHp[theirs]).toBeCloseTo(25, 6);
  });

  it('advanceAge techs advance the player age and set researched', () => {
    const w = makeWorld([CivId.Britons], Age.Dark);
    const before = w.players[1].statsVersion;
    applyTechEffects(w, 1, TechId.FeudalAge);
    expect(w.players[1].age).toBe(Age.Feudal);
    expect(w.players[1].researched[TechId.FeudalAge]).toBe(1);
    expect(w.players[1].statsVersion).toBeGreaterThan(before);
  });
});
