import { inBounds, tileIndex, tileXOf, tileYOf } from '../shared/constants';
import { ResourceNode, Terrain } from '../shared/enums';
import type { TileMap } from '../shared/world';

/**
 * Allocate a fresh, all-grass, resource-free tile map.
 * occupant is filled with -1 (no building); every other array is zeroed
 * (Grass / ResourceNode.None / no visibility / not explored).
 */
export function createTileMap(size: number): TileMap {
  const n = size * size;
  const occupant = new Int32Array(n);
  occupant.fill(-1);
  return {
    size,
    terrain: new Uint8Array(n), // Terrain.Grass === 0
    resourceType: new Uint8Array(n), // ResourceNode.None === 0
    resourceAmount: new Float32Array(n),
    occupant,
    visible: new Uint8Array(n),
    explored: new Uint8Array(n),
  };
}

/**
 * A tile is walkable iff it is in bounds, not Water, carries no resource node
 * (trees / mines / forage block movement) and is not occupied by a building.
 */
export function isWalkable(map: TileMap, tx: number, ty: number): boolean {
  if (!inBounds(map.size, tx, ty)) return false;
  const idx = tileIndex(map.size, tx, ty);
  return (
    map.terrain[idx] !== Terrain.Water &&
    map.resourceType[idx] === ResourceNode.None &&
    map.occupant[idx] === -1
  );
}

/**
 * True iff every tile of the sizeX x sizeY footprint anchored at (tileX,tileY)
 * is walkable (in bounds, land, resource-free, unoccupied).
 */
export function canPlaceBuilding(
  map: TileMap,
  tileX: number,
  tileY: number,
  sizeX: number,
  sizeY: number,
): boolean {
  for (let dy = 0; dy < sizeY; dy++) {
    for (let dx = 0; dx < sizeX; dx++) {
      if (!isWalkable(map, tileX + dx, tileY + dy)) return false;
    }
  }
  return true;
}

/**
 * Nearest tile carrying the given resource-node type, searched as expanding
 * Chebyshev rings out to `maxRadius` (inclusive). Within the closest ring that
 * contains a match, ties are broken by lowest tile index. Returns -1 if none.
 */
export function nearestResourceTile(
  map: TileMap,
  fromTile: number,
  node: ResourceNode,
  maxRadius: number,
): number {
  const size = map.size;
  const fx = tileXOf(size, fromTile);
  const fy = tileYOf(size, fromTile);
  for (let r = 0; r <= maxRadius; r++) {
    let best = -1;
    for (let dy = -r; dy <= r; dy++) {
      const ty = fy + dy;
      if (ty < 0 || ty >= size) continue;
      const onHorizEdge = dy === -r || dy === r;
      for (let dx = -r; dx <= r; dx++) {
        // Only the perimeter of the current ring.
        if (!onHorizEdge && dx !== -r && dx !== r) continue;
        const tx = fx + dx;
        if (tx < 0 || tx >= size) continue;
        const idx = tileIndex(size, tx, ty);
        if (map.resourceType[idx] === node && (best === -1 || idx < best)) {
          best = idx;
        }
      }
    }
    if (best !== -1) return best;
  }
  return -1;
}

/**
 * First walkable tile adjacent to the sizeX x sizeY footprint anchored at
 * (tileX,tileY), used for deterministic unit spawn/placement next to a
 * building. Scan order per ring (review requiredChanges #6):
 *   south edge west->east, east edge north->south,
 *   north edge west->east, west edge north->south.
 * The ring is expanded outward up to +3 tiles; returns -1 if nothing is
 * walkable within that range.
 */
export function adjacentSpawnTile(
  map: TileMap,
  tileX: number,
  tileY: number,
  sizeX: number,
  sizeY: number,
): number {
  const size = map.size;
  for (let m = 1; m <= 3; m++) {
    const xWest = tileX - m;
    const xEast = tileX + sizeX - 1 + m;
    const yNorth = tileY - m;
    const ySouth = tileY + sizeY - 1 + m;

    // 1. south edge, west -> east
    for (let x = xWest; x <= xEast; x++) {
      if (isWalkable(map, x, ySouth)) return tileIndex(size, x, ySouth);
    }
    // 2. east edge, north -> south
    for (let y = yNorth; y <= ySouth; y++) {
      if (isWalkable(map, xEast, y)) return tileIndex(size, xEast, y);
    }
    // 3. north edge, west -> east
    for (let x = xWest; x <= xEast; x++) {
      if (isWalkable(map, x, yNorth)) return tileIndex(size, x, yNorth);
    }
    // 4. west edge, north -> south
    for (let y = yNorth; y <= ySouth; y++) {
      if (isWalkable(map, xWest, y)) return tileIndex(size, xWest, y);
    }
  }
  return -1;
}
