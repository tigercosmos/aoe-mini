import { ArmorClass, BuildingType, CivId, GatherSource, Resource, UnitType } from '../shared/enums';
import { TICK_RATE } from '../shared/constants';
import type { CivDef } from '../shared/content-types';

// Civilization definitions — each is exactly a unique unit + three Modifier bonuses (pure data;
// the three civs need zero special-case code). Consumed by content/stats.ts resolvers.
export const CIVS: Readonly<Record<CivId, CivDef>> = {
  [CivId.Britons]: {
    id: CivId.Britons,
    name: 'Britons',
    uniqueUnit: UnitType.Longbowman,
    bonuses: [
      // All archer-class units +1 range.
      { type: 'unitStat', stat: 'range', filter: { classMask: ArmorClass.Archer }, add: 1 },
      // Town Centers cost half wood.
      { type: 'costMul', building: BuildingType.TownCenter, resource: Resource.Wood, mul: 0.5 },
      // Shepherds gather 25% faster.
      { type: 'gatherRate', source: GatherSource.Sheep, mul: 1.25 },
    ],
  },
  [CivId.Franks]: {
    id: CivId.Franks,
    name: 'Franks',
    uniqueUnit: UnitType.ThrowingAxeman,
    bonuses: [
      // Knights +20% HP.
      { type: 'unitStat', stat: 'hp', filter: { units: [UnitType.Knight] }, mul: 1.2 },
      // Foragers gather 25% faster.
      { type: 'gatherRate', source: GatherSource.Forage, mul: 1.25 },
      // Castles 25% cheaper (all resources).
      { type: 'costMul', building: BuildingType.Castle, resource: -1, mul: 0.75 },
    ],
  },
  [CivId.Mongols]: {
    id: CivId.Mongols,
    name: 'Mongols',
    uniqueUnit: UnitType.Mangudai,
    bonuses: [
      // Scout-cavalry line +30% HP.
      { type: 'unitStat', stat: 'hp', filter: { units: [UnitType.ScoutCavalry] }, mul: 1.3 },
      // Mangudai fire 25% faster (attack rate *0.8).
      { type: 'attackRateMul', filter: { units: [UnitType.Mangudai] }, mul: 0.8 },
      // Military (infantry/archer/cavalry) trains 10% faster.
      {
        type: 'trainTimeMul',
        filter: { classMask: ArmorClass.Infantry | ArmorClass.Archer | ArmorClass.Cavalry },
        mul: 0.9,
      },
    ],
  },
};

// Per-tick gather amounts by source: contentDesign units/sec divided by TICK_RATE (20).
// Civ/tech gatherRate multipliers are layered on top by content/stats.gatherRatePerTick().
export const GATHER_RATE_PER_TICK: Readonly<Record<GatherSource, number>> = {
  [GatherSource.Forage]: 0.31 / TICK_RATE,
  [GatherSource.Sheep]: 0.33 / TICK_RATE,
  [GatherSource.Farm]: 0.3 / TICK_RATE,
  [GatherSource.Wood]: 0.39 / TICK_RATE,
  [GatherSource.Gold]: 0.38 / TICK_RATE,
  [GatherSource.Stone]: 0.36 / TICK_RATE,
};
