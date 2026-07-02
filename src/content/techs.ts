import { Age, ArmorClass, BuildingType, TechId, UnitType } from '../shared/enums';
import type { TechDef } from '../shared/content-types';

// Base tech definitions — single source of truth from contentDesign. Ages are expressed as
// techs (FeudalAge/CastleAge/ImperialAge) whose only effect is { advanceAge }. Effects are
// plain Modifier data consumed by content/stats.ts (resolvers + applyTechEffects).
export const TECHS: Readonly<Record<TechId, TechDef>> = {
  [TechId.Loom]: {
    name: 'Loom',
    cost: { food: 0, wood: 0, gold: 50, stone: 0 },
    researchTicks: 500,
    researchedAt: BuildingType.TownCenter,
    requiresAge: Age.Dark,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'hp', filter: { units: [UnitType.Villager] }, add: 15 },
      { type: 'unitStat', stat: 'meleeArmor', filter: { units: [UnitType.Villager] }, add: 1 },
      { type: 'unitStat', stat: 'pierceArmor', filter: { units: [UnitType.Villager] }, add: 1 },
    ],
  },
  [TechId.Wheelbarrow]: {
    name: 'Wheelbarrow',
    cost: { food: 175, wood: 50, gold: 0, stone: 0 },
    researchTicks: 1500,
    researchedAt: BuildingType.TownCenter,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'speed', filter: { units: [UnitType.Villager] }, mul: 1.1 },
      { type: 'carryCapacity', mul: 1.25 },
    ],
  },
  [TechId.ManAtArmsUpgrade]: {
    name: 'Man-at-Arms Upgrade',
    cost: { food: 100, wood: 0, gold: 40, stone: 0 },
    researchTicks: 800,
    researchedAt: BuildingType.Barracks,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [{ type: 'upgradeLine', from: UnitType.Militia, to: UnitType.ManAtArms }],
  },
  [TechId.Forging]: {
    name: 'Forging',
    cost: { food: 150, wood: 0, gold: 0, stone: 0 },
    researchTicks: 1000,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'attack', filter: { classMask: ArmorClass.Infantry | ArmorClass.Cavalry }, add: 1 },
    ],
  },
  [TechId.IronCasting]: {
    name: 'Iron Casting',
    cost: { food: 220, wood: 0, gold: 120, stone: 0 },
    researchTicks: 1500,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Castle,
    requiresTech: TechId.Forging,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'attack', filter: { classMask: ArmorClass.Infantry | ArmorClass.Cavalry }, add: 1 },
    ],
  },
  [TechId.Fletching]: {
    name: 'Fletching',
    cost: { food: 100, wood: 0, gold: 50, stone: 0 },
    researchTicks: 600,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'attack', filter: { classMask: ArmorClass.Archer }, add: 1 },
      { type: 'unitStat', stat: 'range', filter: { classMask: ArmorClass.Archer }, add: 1 },
    ],
  },
  [TechId.BodkinArrow]: {
    name: 'Bodkin Arrow',
    cost: { food: 200, wood: 0, gold: 100, stone: 0 },
    researchTicks: 700,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Castle,
    requiresTech: TechId.Fletching,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'attack', filter: { classMask: ArmorClass.Archer }, add: 1 },
      { type: 'unitStat', stat: 'range', filter: { classMask: ArmorClass.Archer }, add: 1 },
    ],
  },
  [TechId.ScaleMailArmor]: {
    name: 'Scale Mail Armor',
    cost: { food: 100, wood: 0, gold: 0, stone: 0 },
    researchTicks: 600,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'meleeArmor', filter: { classMask: ArmorClass.Infantry }, add: 1 },
      { type: 'unitStat', stat: 'pierceArmor', filter: { classMask: ArmorClass.Infantry }, add: 1 },
    ],
  },
  [TechId.ChainMailArmor]: {
    name: 'Chain Mail Armor',
    cost: { food: 200, wood: 0, gold: 100, stone: 0 },
    researchTicks: 1100,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Castle,
    requiresTech: TechId.ScaleMailArmor,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'meleeArmor', filter: { classMask: ArmorClass.Infantry }, add: 1 },
      { type: 'unitStat', stat: 'pierceArmor', filter: { classMask: ArmorClass.Infantry }, add: 1 },
    ],
  },
  [TechId.ScaleBardingArmor]: {
    name: 'Scale Barding Armor',
    cost: { food: 150, wood: 0, gold: 0, stone: 0 },
    researchTicks: 900,
    researchedAt: BuildingType.Blacksmith,
    requiresAge: Age.Feudal,
    requiresTech: -1,
    requiresBuilding: -1,
    effects: [
      { type: 'unitStat', stat: 'meleeArmor', filter: { classMask: ArmorClass.Cavalry }, add: 1 },
      { type: 'unitStat', stat: 'pierceArmor', filter: { classMask: ArmorClass.Cavalry }, add: 1 },
    ],
  },
  [TechId.FeudalAge]: {
    name: 'Feudal Age',
    cost: { food: 500, wood: 0, gold: 0, stone: 0 },
    researchTicks: 2600,
    researchedAt: BuildingType.TownCenter,
    requiresAge: Age.Dark,
    requiresTech: -1,
    requiresBuilding: BuildingType.Barracks,
    effects: [{ type: 'advanceAge', to: Age.Feudal }],
  },
  [TechId.CastleAge]: {
    name: 'Castle Age',
    cost: { food: 800, wood: 0, gold: 200, stone: 0 },
    researchTicks: 3200,
    researchedAt: BuildingType.TownCenter,
    requiresAge: Age.Feudal,
    requiresTech: TechId.FeudalAge,
    requiresBuilding: BuildingType.Blacksmith,
    effects: [{ type: 'advanceAge', to: Age.Castle }],
  },
  [TechId.ImperialAge]: {
    name: 'Imperial Age',
    cost: { food: 1000, wood: 0, gold: 800, stone: 0 },
    researchTicks: 3800,
    researchedAt: BuildingType.TownCenter,
    requiresAge: Age.Castle,
    requiresTech: TechId.CastleAge,
    requiresBuilding: BuildingType.Castle,
    effects: [{ type: 'advanceAge', to: Age.Imperial }],
  },
};

// Age -> the tech that advances INTO it (Dark has no advancing tech).
export const AGE_TECH: Readonly<Record<Age, TechId | -1>> = {
  [Age.Dark]: -1,
  [Age.Feudal]: TechId.FeudalAge,
  [Age.Castle]: TechId.CastleAge,
  [Age.Imperial]: TechId.ImperialAge,
};
