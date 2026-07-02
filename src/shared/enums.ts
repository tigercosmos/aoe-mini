export type PlayerId = number;            // 0 = Gaia; 1..3 = players
export const GAIA: PlayerId = 0;

export const Resource = { Food: 0, Wood: 1, Gold: 2, Stone: 3 } as const;
export type Resource = (typeof Resource)[keyof typeof Resource];
export const RESOURCE_COUNT = 4;

export const Age = { Dark: 0, Feudal: 1, Castle: 2, Imperial: 3 } as const;
export type Age = (typeof Age)[keyof typeof Age];
export const AGE_COUNT = 4;

export const CivId = { Britons: 0, Franks: 1, Mongols: 2 } as const;
export type CivId = (typeof CivId)[keyof typeof CivId];
export const CIV_COUNT = 3;

export const UnitType = {
  Villager: 0, Militia: 1, ManAtArms: 2, Spearman: 3, Archer: 4,
  ScoutCavalry: 5, Knight: 6, Longbowman: 7, ThrowingAxeman: 8, Mangudai: 9, Sheep: 10,
} as const;
export type UnitType = (typeof UnitType)[keyof typeof UnitType];
export const UNIT_TYPE_COUNT = 11;

export const BuildingType = {
  TownCenter: 0, House: 1, Mill: 2, LumberCamp: 3, MiningCamp: 4, Farm: 5,
  Barracks: 6, ArcheryRange: 7, Stable: 8, Blacksmith: 9, Castle: 10,
} as const;
export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];
export const BUILDING_TYPE_COUNT = 11;

export const TechId = {
  Loom: 0, Wheelbarrow: 1, ManAtArmsUpgrade: 2, Forging: 3, IronCasting: 4,
  Fletching: 5, BodkinArrow: 6, ScaleMailArmor: 7, ChainMailArmor: 8, ScaleBardingArmor: 9,
  FeudalAge: 10, CastleAge: 11, ImperialAge: 12,
} as const;
export type TechId = (typeof TechId)[keyof typeof TechId];
export const TECH_COUNT = 13;

export const EntityKind = { Unit: 0, Building: 1, Projectile: 2 } as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const Terrain = { Grass: 0, Dirt: 1, Water: 2 } as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export const ResourceNode = { None: 0, Tree: 1, Forage: 2, GoldMine: 3, StoneMine: 4 } as const;
export type ResourceNode = (typeof ResourceNode)[keyof typeof ResourceNode];

export const GatherSource = { Forage: 0, Sheep: 1, Farm: 2, Wood: 3, Gold: 4, Stone: 5 } as const;
export type GatherSource = (typeof GatherSource)[keyof typeof GatherSource];
export const GATHER_SOURCE_COUNT = 6;

export const OrderType = {
  Idle: 0, Move: 1, AttackMove: 2, AttackTarget: 3,
  GatherTile: 4, GatherEntity: 5, ReturnResource: 6, Build: 7,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

// Bitmask armor/unit classes (an entity may have several).
export const ArmorClass = { Infantry: 1, Archer: 2, Cavalry: 4, Building: 8, Villager: 16, UniqueUnit: 32 } as const;

export const ProjectileType = { Arrow: 0, Axe: 1 } as const; // Arrow deals pierce damage; Axe deals melee damage
export type ProjectileType = (typeof ProjectileType)[keyof typeof ProjectileType];

export const MatchStatus = { Running: 0, Ended: 1 } as const;
export type MatchStatus = (typeof MatchStatus)[keyof typeof MatchStatus];

// comp.flags bits
export const FLAG_UNDER_CONSTRUCTION = 1;

// ---- Shared node/resource mapping helpers (review requiredChanges #5) ----
// Single source of truth for ResourceNode -> GatherSource -> Resource so T5 (carryType,
// gather rate) and T6 (economy split, camp placement) never diverge with ad-hoc tables.

/** ResourceNode -> the GatherSource used while harvesting it, or -1 for None/unknown. */
export function nodeToGatherSource(node: ResourceNode): GatherSource | -1 {
  switch (node) {
    case ResourceNode.Tree: return GatherSource.Wood;
    case ResourceNode.Forage: return GatherSource.Forage;
    case ResourceNode.GoldMine: return GatherSource.Gold;
    case ResourceNode.StoneMine: return GatherSource.Stone;
    default: return -1;
  }
}

/** ResourceNode -> the Resource it yields, or -1 for None/unknown. */
export function nodeToResource(node: ResourceNode): Resource | -1 {
  switch (node) {
    case ResourceNode.Tree: return Resource.Wood;
    case ResourceNode.Forage: return Resource.Food;
    case ResourceNode.GoldMine: return Resource.Gold;
    case ResourceNode.StoneMine: return Resource.Stone;
    default: return -1;
  }
}

/** GatherSource -> the Resource carried/deposited. Total function (exhaustive + final return). */
export function gatherSourceToResource(s: GatherSource): Resource {
  switch (s) {
    case GatherSource.Forage:
    case GatherSource.Sheep:
    case GatherSource.Farm:
      return Resource.Food;
    case GatherSource.Wood:
      return Resource.Wood;
    case GatherSource.Gold:
      return Resource.Gold;
    case GatherSource.Stone:
      return Resource.Stone;
    default:
      return Resource.Food;
  }
}
