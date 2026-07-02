import type { Age, BuildingType, CivId, GatherSource, ProjectileType, Resource, TechId, UnitType } from './enums';

export interface Cost { food: number; wood: number; gold: number; stone: number }
export interface AttackBonus { classMask: number; amount: number } // extra dmg if target.armorClasses & classMask

export interface UnitStats {
  name: string;
  cost: Cost;
  popCost: number;              // Sheep = 0
  trainTicks: number;
  trainedAt: BuildingType | -1; // -1 = not trainable (Sheep)
  requiresAge: Age;
  requiresTech: TechId | -1;    // ManAtArms requires ManAtArmsUpgrade
  hp: number;
  attack: number;
  attackIsPierce: boolean;      // archers/buildings: true; ThrowingAxeman: false (melee dmg at range)
  attackRange: number;          // tiles; 0 = melee
  attackRateTicks: number;
  meleeArmor: number;
  pierceArmor: number;
  speedTilesPerSec: number;
  los: number;
  radius: number;
  armorClasses: number;         // ArmorClass bitmask
  bonuses: AttackBonus[];
  projectile: ProjectileType | -1;
  projectileSpeed: number;      // tiles/sec; 0 for melee units
}

export interface BuildingStats {
  name: string;
  cost: Cost;
  buildTicks: number;           // total villager-work ticks (1 villager => buildTicks/TICK_RATE seconds)
  hp: number;
  meleeArmor: number;
  pierceArmor: number;
  sizeX: number; sizeY: number; // footprint in tiles
  los: number;
  attack: number;               // 0 = no attack; building attacks are ALWAYS pierce, via Arrow projectile
  attackRange: number;
  attackRateTicks: number;
  popProvided: number;
  dropOff: number;              // bitmask (1 << Resource); 0 = not a drop-off
  trains: UnitType[];           // Castle: [] — it trains CIVS[player.civ].uniqueUnit (rule in content/stats)
  researches: TechId[];
  requiresAge: Age;
  requiresBuilding: BuildingType | -1;
  armorClasses: number;         // always includes ArmorClass.Building
  storesFood: number;           // Farm: FARM_FOOD; else 0 (copied to comp.storedResource on completion)
}

/** Empty/omitted filter = matches every unit type. Matches if unit is listed OR its armorClasses overlap classMask. */
export interface UnitFilter { units?: UnitType[]; classMask?: number }

export type Modifier =
  | { type: 'unitStat'; stat: 'hp' | 'attack' | 'range' | 'meleeArmor' | 'pierceArmor' | 'speed' | 'los'; filter: UnitFilter; add?: number; mul?: number }
  | { type: 'attackRateMul'; filter: UnitFilter; mul: number }     // < 1 = attacks faster
  | { type: 'gatherRate'; source: GatherSource | -1; mul: number } // -1 = all sources
  | { type: 'carryCapacity'; add?: number; mul?: number }
  | { type: 'costMul'; unit?: UnitType; building?: BuildingType; tech?: TechId; resource: Resource | -1; mul: number }
  | { type: 'trainTimeMul'; filter: UnitFilter; mul: number }
  | { type: 'upgradeLine'; from: UnitType; to: UnitType }          // converts live units + replaces trainable line
  | { type: 'advanceAge'; to: Age };

export interface TechDef {
  name: string;
  cost: Cost;
  researchTicks: number;
  researchedAt: BuildingType;
  requiresAge: Age;
  requiresTech: TechId | -1;
  requiresBuilding: BuildingType | -1; // e.g. FeudalAge requires a completed Barracks
  effects: Modifier[];
}

export interface CivDef { id: CivId; name: string; uniqueUnit: UnitType; bonuses: Modifier[] }

export interface ResolvedUnitStats {
  hp: number; attack: number; attackIsPierce: boolean; attackRange: number; attackRateTicks: number;
  meleeArmor: number; pierceArmor: number; speedPerTick: number; los: number; radius: number;
  popCost: number; armorClasses: number; bonuses: AttackBonus[];
  projectile: ProjectileType | -1; projectileSpeedPerTick: number;
  trainTicks: number; cost: Cost;
}
export interface ResolvedBuildingStats {
  hp: number; meleeArmor: number; pierceArmor: number; los: number;
  attack: number; attackRange: number; attackRateTicks: number;
  buildTicks: number; cost: Cost; sizeX: number; sizeY: number;
  popProvided: number; dropOff: number; armorClasses: number; storesFood: number;
}
