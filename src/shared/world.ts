import { HANDLE_INDEX_BITS, HANDLE_INDEX_MASK } from './constants';
import type { Age, CivId, MatchStatus, PlayerId, TechId, UnitType } from './enums';
import type { GameEvent } from './events';

export interface Rng { s: number } // mulberry32 state (uint32). Mutated in place by rngNext.

export interface EntityManager {
  readonly capacity: number;
  aliveCount: number;
  readonly alive: Uint8Array;        // 1 = alive
  readonly generation: Uint16Array;  // bumped on destroy
  create(): number;                  // -> entity INDEX; throws Error('entity capacity exceeded') when full; reuses lowest free index (free-list kept sorted or min-heap) for determinism
  destroy(index: number): void;
  isAlive(index: number): boolean;
  handleFor(index: number): number;  // makeHandle(index, generation[index])
}

export function makeHandle(index: number, generation: number): number {
  return (((generation << HANDLE_INDEX_BITS) >>> 0) | index) >>> 0;
}
export function handleIndex(h: number): number { return h & HANDLE_INDEX_MASK; }
/** -> live entity index, or -1 if handle is -1, stale, or dead. ALWAYS use before touching a stored target. */
export function resolveHandle(em: EntityManager, h: number): number {
  if (h < 0) return -1;
  const i = h & HANDLE_INDEX_MASK;
  return em.alive[i] === 1 && em.handleFor(i) === h ? i : -1;
}

export type ProductionItem =
  | { kind: 'unit'; unit: UnitType; ticksLeft: number; totalTicks: number }
  | { kind: 'tech'; tech: TechId; ticksLeft: number; totalTicks: number };

/** Structure-of-Arrays component storage, all length == capacity (MAX_ENTITIES). Slots are fully zeroed/reset on entity destroy (resetEntityComponents) so checksums are stable. Stats arrays hold EFFECTIVE values (base + civ + researched techs); content/stats.applyTechEffects patches live entities when a tech completes. */
export interface ComponentStores {
  readonly capacity: number;
  kind: Uint8Array;            // EntityKind
  subtype: Uint16Array;        // UnitType | BuildingType | ProjectileType (interpret via kind)
  owner: Uint8Array;           // PlayerId
  flags: Uint8Array;           // FLAG_* bits
  posX: Float32Array; posY: Float32Array;   // world coords in tile units; buildings: footprint CENTER (tileX + sizeX/2)
  prevX: Float32Array; prevY: Float32Array; // previous-tick position (renderer interpolation)
  radius: Float32Array;        // collision radius in tiles
  sizeX: Uint8Array;           // building footprint width in tiles; 0 for units/projectiles (written by spawnBuilding from resolved stats)
  sizeY: Uint8Array;           // building footprint height in tiles; 0 for units/projectiles
  speed: Float32Array;         // tiles per TICK (already divided by TICK_RATE)
  hp: Float32Array; maxHp: Float32Array;
  attack: Float32Array;
  attackRange: Float32Array;   // 0 = melee (attack when within radius sum + 0.2)
  attackRateTicks: Float32Array;
  attackCooldown: Float32Array; // ticks until next swing allowed
  meleeArmor: Float32Array; pierceArmor: Float32Array;
  los: Float32Array;           // line-of-sight radius in tiles
  orderType: Uint8Array;       // OrderType
  orderTarget: Int32Array;     // entity HANDLE or -1
  orderTile: Int32Array;       // tile index or -1 (GatherTile node)
  orderX: Float32Array; orderY: Float32Array; // move/attack-move destination
  resumeTarget: Int32Array;    // handle to resume gathering after drop-off, -1 = none
  resumeTile: Int32Array;      // tile index to resume gathering, -1 = none
  carryType: Uint8Array;       // Resource; meaningful only when carryAmount > 0
  carryAmount: Float32Array;
  workTimer: Float32Array;     // fractional gather/attack accumulator
  storedResource: Float32Array; // Sheep / Farm remaining food; entity dies at 0
  buildProgress: Float32Array; // villager-work ticks applied; construction completes at stats.buildTicks
  rallyX: Float32Array; rallyY: Float32Array; // -1 = unset
  projDamage: Float32Array;    // pre-armor damage incl. attack bonuses, locked at fire time
  projSource: Int32Array;      // firing entity handle (kill credit); projectile damage type from subtype (Arrow=pierce, Axe=melee)
  // Index-aligned side stores (JS arrays; null when unused):
  path: (Uint16Array | null)[];    // packed tile indices (tileIndex()); waypoints walked in order
  pathStep: Int32Array;            // next waypoint index into path; -1 = no active path
  pathVersion: Int32Array;         // pathCache.version stamped at requestPath time; re-path when != current version and next waypoint no longer walkable
  queue: (ProductionItem[] | null)[]; // building production queue; item [0] is in progress
}

export interface TileMap {
  size: number;
  terrain: Uint8Array;         // Terrain
  resourceType: Uint8Array;    // ResourceNode
  resourceAmount: Float32Array; // remaining wood/food/gold/stone on the node
  occupant: Int32Array;        // building HANDLE occupying this tile, or -1
  visible: Uint8Array;         // bit p (1 << PlayerId) = currently in LOS of player p
  explored: Uint8Array;        // bit p = ever seen by player p
}

export interface SpatialGrid {
  readonly cellSize: number;
  /** Re-bucket all alive Unit+Building entities, iterating indexes ascending (=> per-cell lists sorted => deterministic queries). Called once per tick by movementSystem (at its end). Because the grid reflects END-of-movement positions, ONLY combatSystem/projectileSystem (same tick, post-rebuild) and render/UI picking may query it. Systems running before movementSystem (applyCommands, productionSystem, villagerSystem) MUST use linear/ring scans instead (findDropOff = ascending linear scan; villager retarget = nearestResourceTile ring scan; AI placement = spiral tile scan) — the grid holds last tick's buckets and a reused index may sit at a stale position. */
  rebuild(em: EntityManager, comp: ComponentStores): void;
  /** Fill `out` with alive entity INDEXES (ascending) whose position is within r of (x,y). Returns count (capped at out.length). Zero-alloc: caller owns scratch. */
  queryCircle(x: number, y: number, r: number, out: Int32Array): number;
  queryRect(minX: number, minY: number, maxX: number, maxY: number, out: Int32Array): number;
}

export interface PathCache {
  version: number; // bump to invalidate everything (building placed/destroyed changes walkability); a version bump MUST also call entries.clear() so stale entries never accumulate
  entries: Map<number, { version: number; path: Uint16Array }>; // key = startTile * size*size + goalTile
  hits: number; misses: number;
}

export interface PlayerState {
  id: PlayerId;
  civ: CivId;
  isAI: boolean;
  alive: boolean;              // false once defeated (Gaia: always false)
  resources: Float32Array;     // length RESOURCE_COUNT, indexed by Resource; fractional (UI floors)
  population: number;          // sum popCost of alive units
  populationCap: number;       // min(sum popProvided of COMPLETED buildings, POP_CAP_MAX)
  age: Age;
  researched: Uint8Array;      // length TECH_COUNT; 1 = researched
  statsVersion: number;        // bumped by applyTechEffects and on age change; keys the content/stats.ts resolver memo (derived-data cache, no determinism impact)
}

export interface World {
  tick: number;
  seed: number;
  rng: Rng;                    // sim-owned; ONLY sim systems may draw from it
  mapSize: number;
  em: EntityManager;
  comp: ComponentStores;
  map: TileMap;
  grid: SpatialGrid;
  pathCache: PathCache;
  players: PlayerState[];     // [0] = Gaia
  events: GameEvent[];         // events of the CURRENT tick; cleared at the start of stepWorld
  status: MatchStatus;
  winner: PlayerId;            // -1 while running / on timeout
}

export interface MapGenResult {
  starts: { x: number; y: number }[]; // per player 1..N: top-left tile of the starting Town Center
  sheep: { x: number; y: number }[];  // gaia sheep spawn positions (world coords)
}
