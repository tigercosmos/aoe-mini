import {
  BUILDING_TYPE_COUNT,
  BuildingType,
  EntityKind,
  GATHER_SOURCE_COUNT,
  GatherSource,
  Resource,
  TECH_COUNT,
  TechId,
  UNIT_TYPE_COUNT,
  UnitType,
} from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import { BASE_CARRY_CAPACITY, TICK_RATE } from '../shared/constants';
import type {
  Cost,
  Modifier,
  ResolvedBuildingStats,
  ResolvedUnitStats,
  UnitFilter,
} from '../shared/content-types';
import type { PlayerState, World } from '../shared/world';
import { UNIT_STATS } from './units';
import { BUILDING_STATS } from './buildings';
import { TECHS } from './techs';
import { CIVS, GATHER_RATE_PER_TICK } from './civs';

// ---------------------------------------------------------------------------
// Derived-stat resolution engine.
//
// A player's EFFECTIVE stats are the base tables (units/buildings/techs) with the player's civ
// bonuses and researched-tech effects layered on (add first, then mul, per stat). Because the
// hot systems (villager gather, combat) query these every tick, results are cached in a
// module-level memo keyed by the PlayerState object (safe across independent World instances)
// and validated by PlayerState.statsVersion — which applyTechEffects() bumps whenever a tech
// completes or the age advances. The cache is pure derived data: it never influences the world
// checksum, so it has zero determinism impact.
// ---------------------------------------------------------------------------

interface MemoEntry {
  version: number;
  modifiers: Modifier[];
  unit: (ResolvedUnitStats | null)[]; // length UNIT_TYPE_COUNT; lazily filled
  building: (ResolvedBuildingStats | null)[]; // length BUILDING_TYPE_COUNT; lazily filled
  gather: Float64Array; // length GATHER_SOURCE_COUNT
  carry: number;
}

const MEMO = new WeakMap<PlayerState, MemoEntry>();

/** Collect the ordered modifier list for a player: civ bonuses first, then researched techs in
 *  ascending TechId order (stable, deterministic). */
function computeModifiers(p: PlayerState): Modifier[] {
  const out: Modifier[] = [];
  const civ = CIVS[p.civ];
  for (let i = 0; i < civ.bonuses.length; i++) out.push(civ.bonuses[i]);
  for (let t = 0; t < TECH_COUNT; t++) {
    if (p.researched[t] === 1) {
      const effects = TECHS[t as TechId].effects;
      for (let e = 0; e < effects.length; e++) out.push(effects[e]);
    }
  }
  return out;
}

function buildEntry(p: PlayerState): MemoEntry {
  const modifiers = computeModifiers(p);

  const gather = new Float64Array(GATHER_SOURCE_COUNT);
  for (let s = 0; s < GATHER_SOURCE_COUNT; s++) {
    let rate = GATHER_RATE_PER_TICK[s as GatherSource];
    for (let i = 0; i < modifiers.length; i++) {
      const m = modifiers[i];
      if (m.type === 'gatherRate' && (m.source === -1 || m.source === s)) rate *= m.mul;
    }
    gather[s] = rate;
  }

  let carryAdd = 0;
  let carryMul = 1;
  for (let i = 0; i < modifiers.length; i++) {
    const m = modifiers[i];
    if (m.type === 'carryCapacity') {
      if (m.add !== undefined) carryAdd += m.add;
      if (m.mul !== undefined) carryMul *= m.mul;
    }
  }
  const carry = Math.floor((BASE_CARRY_CAPACITY + carryAdd) * carryMul);

  return {
    version: p.statsVersion,
    modifiers,
    unit: new Array<ResolvedUnitStats | null>(UNIT_TYPE_COUNT).fill(null),
    building: new Array<ResolvedBuildingStats | null>(BUILDING_TYPE_COUNT).fill(null),
    gather,
    carry,
  };
}

function getEntry(world: World, player: PlayerId): MemoEntry {
  const p = world.players[player];
  let e = MEMO.get(p);
  if (e === undefined || e.version !== p.statsVersion) {
    e = buildEntry(p);
    MEMO.set(p, e);
  }
  return e;
}

/** Empty/omitted filter matches every unit. Otherwise matches if the unit is listed OR its
 *  armor classes overlap the filter's classMask. */
function unitMatches(filter: UnitFilter, unit: UnitType, armorClasses: number): boolean {
  const units = filter.units;
  const mask = filter.classMask;
  const hasUnits = units !== undefined && units.length > 0;
  const hasMask = mask !== undefined && mask !== 0;
  if (!hasUnits && !hasMask) return true;
  if (hasUnits && units!.indexOf(unit) !== -1) return true;
  if (hasMask && (mask! & armorClasses) !== 0) return true;
  return false;
}

interface CostItem {
  unit?: UnitType;
  building?: BuildingType;
  tech?: TechId;
}

function costMulApplies(
  m: Extract<Modifier, { type: 'costMul' }>,
  item: CostItem,
): boolean {
  const specUnit = m.unit !== undefined;
  const specBuilding = m.building !== undefined;
  const specTech = m.tech !== undefined;
  if (!specUnit && !specBuilding && !specTech) return true; // global discount
  if (specUnit && item.unit === m.unit) return true;
  if (specBuilding && item.building === m.building) return true;
  if (specTech && item.tech === m.tech) return true;
  return false;
}

/** Apply matching costMul modifiers to a base cost (per-resource, resource -1 = all), ceil'ing
 *  every component. Returns a fresh Cost. */
function applyCostMul(base: Cost, modifiers: Modifier[], item: CostItem): Cost {
  let mF = 1;
  let mW = 1;
  let mG = 1;
  let mS = 1;
  for (let i = 0; i < modifiers.length; i++) {
    const m = modifiers[i];
    if (m.type !== 'costMul') continue;
    if (!costMulApplies(m, item)) continue;
    if (m.resource === -1) {
      mF *= m.mul;
      mW *= m.mul;
      mG *= m.mul;
      mS *= m.mul;
    } else if (m.resource === Resource.Food) {
      mF *= m.mul;
    } else if (m.resource === Resource.Wood) {
      mW *= m.mul;
    } else if (m.resource === Resource.Gold) {
      mG *= m.mul;
    } else if (m.resource === Resource.Stone) {
      mS *= m.mul;
    }
  }
  return {
    food: Math.ceil(base.food * mF),
    wood: Math.ceil(base.wood * mW),
    gold: Math.ceil(base.gold * mG),
    stone: Math.ceil(base.stone * mS),
  };
}

function computeUnitStats(unit: UnitType, modifiers: Modifier[]): ResolvedUnitStats {
  const b = UNIT_STATS[unit];
  const ac = b.armorClasses;

  let hpAdd = 0;
  let hpMul = 1;
  let atkAdd = 0;
  let atkMul = 1;
  let rangeAdd = 0;
  let rangeMul = 1;
  let mArmAdd = 0;
  let mArmMul = 1;
  let pArmAdd = 0;
  let pArmMul = 1;
  let spdAdd = 0;
  let spdMul = 1;
  let losAdd = 0;
  let losMul = 1;
  let rateMul = 1;
  let trainMul = 1;

  for (let i = 0; i < modifiers.length; i++) {
    const m = modifiers[i];
    if (m.type === 'unitStat') {
      if (!unitMatches(m.filter, unit, ac)) continue;
      const add = m.add ?? 0;
      const mul = m.mul ?? 1;
      switch (m.stat) {
        case 'hp':
          hpAdd += add;
          hpMul *= mul;
          break;
        case 'attack':
          atkAdd += add;
          atkMul *= mul;
          break;
        case 'range':
          rangeAdd += add;
          rangeMul *= mul;
          break;
        case 'meleeArmor':
          mArmAdd += add;
          mArmMul *= mul;
          break;
        case 'pierceArmor':
          pArmAdd += add;
          pArmMul *= mul;
          break;
        case 'speed':
          spdAdd += add;
          spdMul *= mul;
          break;
        case 'los':
          losAdd += add;
          losMul *= mul;
          break;
      }
    } else if (m.type === 'attackRateMul') {
      if (unitMatches(m.filter, unit, ac)) rateMul *= m.mul;
    } else if (m.type === 'trainTimeMul') {
      if (unitMatches(m.filter, unit, ac)) trainMul *= m.mul;
    }
  }

  const speed = (b.speedTilesPerSec + spdAdd) * spdMul;
  return {
    hp: (b.hp + hpAdd) * hpMul,
    attack: (b.attack + atkAdd) * atkMul,
    attackIsPierce: b.attackIsPierce,
    attackRange: (b.attackRange + rangeAdd) * rangeMul,
    attackRateTicks: b.attackRateTicks * rateMul,
    meleeArmor: (b.meleeArmor + mArmAdd) * mArmMul,
    pierceArmor: (b.pierceArmor + pArmAdd) * pArmMul,
    speedPerTick: speed / TICK_RATE,
    los: (b.los + losAdd) * losMul,
    radius: b.radius,
    popCost: b.popCost,
    armorClasses: ac,
    bonuses: b.bonuses, // base table (no v1 modifier touches attack bonuses)
    projectile: b.projectile,
    projectileSpeedPerTick: b.projectileSpeed / TICK_RATE,
    trainTicks: b.trainTicks * trainMul,
    cost: applyCostMul(b.cost, modifiers, { unit }),
  };
}

function computeBuildingStats(building: BuildingType, modifiers: Modifier[]): ResolvedBuildingStats {
  const b = BUILDING_STATS[building];
  return {
    hp: b.hp,
    meleeArmor: b.meleeArmor,
    pierceArmor: b.pierceArmor,
    los: b.los,
    attack: b.attack,
    attackRange: b.attackRange,
    attackRateTicks: b.attackRateTicks,
    buildTicks: b.buildTicks,
    cost: applyCostMul(b.cost, modifiers, { building }),
    sizeX: b.sizeX,
    sizeY: b.sizeY,
    popProvided: b.popProvided,
    dropOff: b.dropOff,
    armorClasses: b.armorClasses,
    storesFood: b.storesFood,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Ordered active modifiers for a player (civ bonuses first, then researched techs ascending).
 *  Returns a fresh array; callers may keep it but must treat entries as read-only. */
export function activeModifiers(world: World, player: PlayerId): Modifier[] {
  return getEntry(world, player).modifiers.slice();
}

export function resolveUnitStats(world: World, player: PlayerId, unit: UnitType): ResolvedUnitStats {
  const e = getEntry(world, player);
  let r = e.unit[unit];
  if (r === null) {
    r = computeUnitStats(unit, e.modifiers);
    e.unit[unit] = r;
  }
  return r;
}

export function resolveBuildingStats(
  world: World,
  player: PlayerId,
  building: BuildingType,
): ResolvedBuildingStats {
  const e = getEntry(world, player);
  let r = e.building[building];
  if (r === null) {
    r = computeBuildingStats(building, e.modifiers);
    e.building[building] = r;
  }
  return r;
}

export function resolveCost(world: World, player: PlayerId, item: CostItem): Cost {
  const modifiers = getEntry(world, player).modifiers;
  let base: Cost;
  if (item.unit !== undefined) base = UNIT_STATS[item.unit].cost;
  else if (item.building !== undefined) base = BUILDING_STATS[item.building].cost;
  else if (item.tech !== undefined) base = TECHS[item.tech].cost;
  else base = { food: 0, wood: 0, gold: 0, stone: 0 };
  return applyCostMul(base, modifiers, item);
}

export function gatherRatePerTick(world: World, player: PlayerId, source: GatherSource): number {
  return getEntry(world, player).gather[source];
}

export function carryCapacity(world: World, player: PlayerId): number {
  return getEntry(world, player).carry;
}

export function canTrain(
  world: World,
  player: PlayerId,
  building: BuildingType,
  unit: UnitType,
): boolean {
  const p = world.players[player];
  // The Castle trains ONLY the civ's unique unit; all other buildings use their trains[] list.
  if (building === BuildingType.Castle) {
    if (unit !== CIVS[p.civ].uniqueUnit) return false;
  } else {
    if (BUILDING_STATS[building].trains.indexOf(unit) === -1) return false;
  }
  const us = UNIT_STATS[unit];
  if (p.age < us.requiresAge) return false;
  if (us.requiresTech !== -1 && p.researched[us.requiresTech] !== 1) return false;
  // An upgradeLine effect hides the obsolete 'from' unit (e.g. Militia after Man-at-Arms upgrade).
  const modifiers = getEntry(world, player).modifiers;
  for (let i = 0; i < modifiers.length; i++) {
    const m = modifiers[i];
    if (m.type === 'upgradeLine' && m.from === unit) return false;
  }
  return true;
}

export function canResearch(world: World, player: PlayerId, tech: TechId): boolean {
  const p = world.players[player];
  if (p.researched[tech] === 1) return false;
  const def = TECHS[tech];
  if (p.age < def.requiresAge) return false;
  if (def.requiresTech !== -1 && p.researched[def.requiresTech] !== 1) return false;
  return true; // requiresBuilding existence is verified by the sim (needs an entity scan)
}

export function canBuildBuilding(world: World, player: PlayerId, building: BuildingType): boolean {
  const p = world.players[player];
  return p.age >= BUILDING_STATS[building].requiresAge; // requiresBuilding verified by the sim
}

/** Apply a completed tech's effects to a player and its live entities. Advances age, converts
 *  upgradeLine unit lines in place, and re-patches affected alive units' comp stat arrays
 *  (maxHp scales, hp shifts by the maxHp delta so damage taken is preserved). Bumps statsVersion
 *  so future resolver calls see the new state. Emits nothing (the production system emits). */
export function applyTechEffects(world: World, player: PlayerId, tech: TechId): void {
  const p = world.players[player];
  p.researched[tech] = 1; // idempotent (the production system sets this before calling)
  const def = TECHS[tech];

  let patchLive = false;
  for (let e = 0; e < def.effects.length; e++) {
    const eff = def.effects[e];
    if (eff.type === 'advanceAge') {
      p.age = eff.to;
    } else if (
      eff.type === 'unitStat' ||
      eff.type === 'attackRateMul' ||
      eff.type === 'upgradeLine'
    ) {
      patchLive = true;
    }
    // gatherRate / carryCapacity / costMul / trainTimeMul affect only future resolution, not
    // already-spawned entities, so they need no per-entity patch here.
  }

  // Invalidate the resolver memo so subsequent resolve* calls reflect the new researched/age
  // state (and the re-resolution below uses the updated modifier set).
  p.statsVersion++;

  if (!patchLive) return;

  const comp = world.comp;
  const em = world.em;
  const cap = comp.capacity;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Unit) continue;
    if (comp.owner[i] !== player) continue;

    // upgradeLine: swap subtype in place before re-resolving (Militia -> Man-at-Arms, etc.).
    for (let e = 0; e < def.effects.length; e++) {
      const eff = def.effects[e];
      if (eff.type === 'upgradeLine' && comp.subtype[i] === eff.from) {
        comp.subtype[i] = eff.to;
      }
    }

    const subtype = comp.subtype[i] as UnitType;
    const rs = resolveUnitStats(world, player, subtype);
    const oldMaxHp = comp.maxHp[i];
    const newMaxHp = rs.hp;
    comp.hp[i] += newMaxHp - oldMaxHp;
    comp.maxHp[i] = newMaxHp;
    comp.attack[i] = rs.attack;
    comp.attackRange[i] = rs.attackRange;
    comp.attackRateTicks[i] = rs.attackRateTicks;
    comp.meleeArmor[i] = rs.meleeArmor;
    comp.pierceArmor[i] = rs.pierceArmor;
    comp.speed[i] = rs.speedPerTick;
    comp.los[i] = rs.los;
    comp.radius[i] = rs.radius;
  }
}
