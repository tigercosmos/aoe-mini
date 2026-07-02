import { describe, it, expect } from 'vitest';
import {
  Age,
  BUILDING_TYPE_COUNT,
  BuildingType,
  CIV_COUNT,
  CivId,
  GATHER_SOURCE_COUNT,
  GatherSource,
  RESOURCE_COUNT,
  TECH_COUNT,
  TechId,
  UNIT_TYPE_COUNT,
  UnitType,
} from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { PlayerState, World } from '../../src/shared/world';
import { UNIT_STATS } from '../../src/content/units';
import { BUILDING_STATS } from '../../src/content/buildings';
import { TECHS, AGE_TECH } from '../../src/content/techs';
import { CIVS, GATHER_RATE_PER_TICK } from '../../src/content/civs';
import { canTrain } from '../../src/content/stats';

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

/** Minimal World satisfying the fields the content resolvers actually read (players only). */
function fakeWorld(playerCivs: CivId[], age: Age): World {
  const players: PlayerState[] = [makePlayer(0, CivId.Britons, Age.Dark)];
  for (let i = 0; i < playerCivs.length; i++) {
    players.push(makePlayer(i + 1, playerCivs[i], age));
  }
  return { players } as unknown as World;
}

function isNonNeg(v: number): boolean {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v);
}

describe('UNIT_STATS table', () => {
  it('has every UnitType key with a shape-valid entry', () => {
    for (let u = 0; u < UNIT_TYPE_COUNT; u++) {
      const s = UNIT_STATS[u as UnitType];
      expect(s, `unit ${u}`).toBeDefined();
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(isNonNeg(s.cost.food)).toBe(true);
      expect(isNonNeg(s.cost.wood)).toBe(true);
      expect(isNonNeg(s.cost.gold)).toBe(true);
      expect(isNonNeg(s.cost.stone)).toBe(true);
      expect(isNonNeg(s.popCost)).toBe(true);
      expect(s.hp).toBeGreaterThan(0);
      expect(isNonNeg(s.attack)).toBe(true);
      expect(isNonNeg(s.attackRange)).toBe(true);
      expect(isNonNeg(s.meleeArmor)).toBe(true);
      expect(isNonNeg(s.pierceArmor)).toBe(true);
      expect(isNonNeg(s.los)).toBe(true);
      expect(s.radius).toBeGreaterThan(0);
      // Trainable units must have a positive train time; Sheep (trainedAt -1) is spawned only.
      if (s.trainedAt !== -1) {
        expect(s.trainTicks).toBeGreaterThan(0);
        expect(s.popCost).toBeGreaterThan(0);
      }
      // Ranged units carry a projectile; pure melee (range 0) do not.
      if (s.attackRange > 0 && s.attack > 0) {
        expect(s.projectile).not.toBe(-1);
        expect(s.projectileSpeed).toBeGreaterThan(0);
      }
    }
  });

  it('pins the canonical golden base numbers', () => {
    expect(UNIT_STATS[UnitType.Villager].hp).toBe(25);
    expect(UNIT_STATS[UnitType.Militia].trainTicks).toBe(420);
    expect(UNIT_STATS[UnitType.Knight].hp).toBe(100);
    expect(UNIT_STATS[UnitType.Mangudai].attackRateTicks).toBe(42);
    expect(UNIT_STATS[UnitType.Longbowman].attackRange).toBe(5);
    expect(UNIT_STATS[UnitType.Archer].attackRange).toBe(4);
    // Sheep is spawn-only (never trained) with zero population cost.
    expect(UNIT_STATS[UnitType.Sheep].trainedAt).toBe(-1);
    expect(UNIT_STATS[UnitType.Sheep].popCost).toBe(0);
  });
});

describe('BUILDING_STATS table', () => {
  it('has every BuildingType key with a shape-valid entry', () => {
    for (let b = 0; b < BUILDING_TYPE_COUNT; b++) {
      const s = BUILDING_STATS[b as BuildingType];
      expect(s, `building ${b}`).toBeDefined();
      expect(s.name.length).toBeGreaterThan(0);
      expect(isNonNeg(s.cost.food)).toBe(true);
      expect(isNonNeg(s.cost.wood)).toBe(true);
      expect(isNonNeg(s.cost.gold)).toBe(true);
      expect(isNonNeg(s.cost.stone)).toBe(true);
      expect(s.buildTicks).toBeGreaterThan(0);
      expect(s.hp).toBeGreaterThan(0);
      expect(s.sizeX).toBeGreaterThan(0);
      expect(s.sizeY).toBeGreaterThan(0);
      expect(isNonNeg(s.popProvided)).toBe(true);
      // Every building carries the Building armor class.
      expect(s.armorClasses & 8).toBe(8); // ArmorClass.Building
    }
  });

  it('Castle trains [] (unique unit handled by the canTrain rule)', () => {
    expect(BUILDING_STATS[BuildingType.Castle].trains).toEqual([]);
  });

  it('Farm stores FARM_FOOD and requires a Mill', () => {
    expect(BUILDING_STATS[BuildingType.Farm].storesFood).toBe(250);
    expect(BUILDING_STATS[BuildingType.Farm].requiresBuilding).toBe(BuildingType.Mill);
  });
});

describe('TECHS + AGE_TECH', () => {
  it('has every TechId key with a shape-valid entry', () => {
    for (let t = 0; t < TECH_COUNT; t++) {
      const def = TECHS[t as TechId];
      expect(def, `tech ${t}`).toBeDefined();
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.researchTicks).toBeGreaterThan(0);
      expect(isNonNeg(def.cost.food)).toBe(true);
      expect(isNonNeg(def.cost.wood)).toBe(true);
      expect(isNonNeg(def.cost.gold)).toBe(true);
      expect(isNonNeg(def.cost.stone)).toBe(true);
      expect(Array.isArray(def.effects)).toBe(true);
      expect(def.effects.length).toBeGreaterThan(0);
    }
  });

  it('AGE_TECH round-trips through the advanceAge effect', () => {
    expect(AGE_TECH[Age.Dark]).toBe(-1);
    for (const age of [Age.Feudal, Age.Castle, Age.Imperial] as const) {
      const tech = AGE_TECH[age];
      expect(tech).not.toBe(-1);
      const def = TECHS[tech as TechId];
      const adv = def.effects.find((e) => e.type === 'advanceAge');
      expect(adv).toBeDefined();
      expect((adv as { type: 'advanceAge'; to: Age }).to).toBe(age);
    }
  });
});

describe('CIVS', () => {
  it('defines exactly CIV_COUNT civs, each with a unique unit and 3 bonuses', () => {
    let count = 0;
    const uniques = new Set<number>();
    for (let c = 0; c < CIV_COUNT; c++) {
      const civ = CIVS[c as CivId];
      expect(civ, `civ ${c}`).toBeDefined();
      expect(civ.id).toBe(c);
      expect(civ.bonuses.length).toBe(3);
      uniques.add(civ.uniqueUnit);
      count++;
    }
    expect(count).toBe(CIV_COUNT);
    expect(uniques.size).toBe(CIV_COUNT); // distinct unique units
    expect(CIVS[CivId.Britons].uniqueUnit).toBe(UnitType.Longbowman);
    expect(CIVS[CivId.Franks].uniqueUnit).toBe(UnitType.ThrowingAxeman);
    expect(CIVS[CivId.Mongols].uniqueUnit).toBe(UnitType.Mangudai);
  });

  it('GATHER_RATE_PER_TICK has every GatherSource and is base rate / TICK_RATE', () => {
    for (let s = 0; s < GATHER_SOURCE_COUNT; s++) {
      expect(GATHER_RATE_PER_TICK[s as GatherSource]).toBeGreaterThan(0);
    }
    // Wood 0.39/s -> 0.0195 per tick.
    expect(GATHER_RATE_PER_TICK[GatherSource.Wood]).toBeCloseTo(0.0195, 10);
  });

  it('each unique unit is trainable ONLY by its own civ (canTrain matrix, Castle age)', () => {
    const civs = [CivId.Britons, CivId.Franks, CivId.Mongols];
    const world = fakeWorld(civs, Age.Castle);
    const uniqueOf: Record<number, UnitType> = {
      [CivId.Britons]: UnitType.Longbowman,
      [CivId.Franks]: UnitType.ThrowingAxeman,
      [CivId.Mongols]: UnitType.Mangudai,
    };
    for (let p = 1; p <= civs.length; p++) {
      const ownCiv = civs[p - 1];
      for (const otherCiv of civs) {
        const unit = uniqueOf[otherCiv];
        const trainable = canTrain(world, p, BuildingType.Castle, unit);
        expect(trainable).toBe(otherCiv === ownCiv);
      }
    }
  });

  it('unique units are never in a non-Castle building trains[] list', () => {
    const uniques = [UnitType.Longbowman, UnitType.ThrowingAxeman, UnitType.Mangudai];
    for (let b = 0; b < BUILDING_TYPE_COUNT; b++) {
      if (b === BuildingType.Castle) continue;
      for (const u of uniques) {
        expect(BUILDING_STATS[b as BuildingType].trains.indexOf(u)).toBe(-1);
      }
    }
  });
});
