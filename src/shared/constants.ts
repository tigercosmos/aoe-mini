export const TICK_RATE = 20;                 // sim ticks per second
export const MS_PER_TICK = 1000 / TICK_RATE; // 50
export const MAX_TICKS_PER_FRAME = 5;        // catch-up cap in the render loop
export const MIN_SIM_SPEED = 1;              // browser sim speed multiplier (HUD toggle)
export const MAX_SIM_SPEED = 5;
export const MAX_ENTITIES = 4096;
export const MAX_PLAYERS = 4;                // slot 0 = Gaia, slots 1..3 = players
export const DEFAULT_MAP_SIZE = 96;          // tiles per side
export const SPATIAL_CELL_SIZE = 4;          // tiles per spatial-hash cell
export const QUERY_BUFFER_SIZE = 512;        // pinned scratch Int32Array length for grid queryCircle/queryRect
export const POP_CAP_MAX = 200;
export const BASE_CARRY_CAPACITY = 10;
export const VISIBILITY_INTERVAL = 5;        // fog recompute every N ticks
export const GATHER_RANGE = 1.25;            // max distance to gather a node/unit target; building gather (farm) uses sizeX/2 + GATHER_RANGE
export const DEPOSIT_RANGE_PAD = 1.0;        // deposit when dist(center) <= sizeX/2 + this
export const PROJECTILE_HIT_DIST = 0.3;
export const SEPARATION_RADIUS = 0.5;        // soft unit-unit push radius
export const RETARGET_NODE_RADIUS = 8;       // auto-retarget depleted node within N tiles
export const TREE_WOOD = 100;
export const FORAGE_FOOD = 125;
export const GOLD_PER_MINE = 800;
export const STONE_PER_MINE = 350;
export const SHEEP_FOOD = 100;
export const FARM_FOOD = 250;
export const STARTING_RESOURCES: readonly number[] = [200, 200, 100, 100]; // by Resource index
export const STARTING_VILLAGERS = 3;
export const DEFAULT_MAX_TICKS = 36_000;     // 30 min headless cap
export const TILE_W = 64;                    // isometric tile pixel width
export const TILE_H = 32;                    // isometric tile pixel height
export const HANDLE_INDEX_BITS = 12;         // MAX_ENTITIES <= 4096
export const HANDLE_INDEX_MASK = 0xfff;
export const NONE = -1;                      // universal 'no entity / no target' sentinel

export function tileIndex(size: number, tx: number, ty: number): number { return ty * size + tx; }
export function tileXOf(size: number, idx: number): number { return idx % size; }
export function tileYOf(size: number, idx: number): number { return (idx / size) | 0; }
export function inBounds(size: number, tx: number, ty: number): boolean { return tx >= 0 && ty >= 0 && tx < size && ty < size; }
