import { describe, expect, it } from 'vitest';
import { RETARGET_NODE_RADIUS, tileIndex, tileXOf, tileYOf } from '../../src/shared/constants';
import { ResourceNode, Terrain } from '../../src/shared/enums';
import type { TileMap } from '../../src/shared/world';
import { findPathRaw } from '../../src/map/astar';
import { createPathCache, findPath } from '../../src/map/pathcache';
import {
  adjacentSpawnTile,
  canPlaceBuilding,
  createTileMap,
  isWalkable,
  nearestResourceTile,
} from '../../src/map/tilemap';

function block(map: TileMap, x: number, y: number): void {
  map.resourceType[tileIndex(map.size, x, y)] = ResourceNode.Tree;
}

/** Assert the path is a chain of 8-adjacent tiles with no corner-cutting. */
function assertValidPath(map: TileMap, path: Uint16Array): void {
  const size = map.size;
  for (let i = 1; i < path.length; i++) {
    const x0 = tileXOf(size, path[i - 1]);
    const y0 = tileYOf(size, path[i - 1]);
    const x1 = tileXOf(size, path[i]);
    const y1 = tileYOf(size, path[i]);
    const dx = x1 - x0;
    const dy = y1 - y0;
    expect(Math.abs(dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(dy)).toBeLessThanOrEqual(1);
    expect(dx !== 0 || dy !== 0).toBe(true);
    // every stepped-onto tile must be walkable
    expect(isWalkable(map, x1, y1)).toBe(true);
    // no corner cutting on diagonal moves
    if (dx !== 0 && dy !== 0) {
      expect(isWalkable(map, x0 + dx, y0)).toBe(true);
      expect(isWalkable(map, x0, y0 + dy)).toBe(true);
    }
  }
}

describe('findPathRaw', () => {
  it('finds a straight path on an open map (inclusive endpoints)', () => {
    const map = createTileMap(20);
    const path = findPathRaw(map, 2, 2, 5, 2);
    expect(path).not.toBeNull();
    const p = path!;
    expect(p.length).toBe(4); // (2,2)(3,2)(4,2)(5,2)
    expect(p[0]).toBe(tileIndex(20, 2, 2));
    expect(p[p.length - 1]).toBe(tileIndex(20, 5, 2));
    assertValidPath(map, p);
  });

  it('returns a single-tile path when start === goal', () => {
    const map = createTileMap(20);
    const path = findPathRaw(map, 7, 7, 7, 7);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(1);
    expect(path![0]).toBe(tileIndex(20, 7, 7));
  });

  it('routes through the single gap in a wall', () => {
    const map = createTileMap(20);
    for (let y = 0; y < 20; y++) {
      if (y === 2) continue; // gap
      block(map, 5, y);
    }
    const path = findPathRaw(map, 2, 10, 8, 10);
    expect(path).not.toBeNull();
    const p = path!;
    // the only crossing of column 5 is the gap tile
    expect(Array.from(p)).toContain(tileIndex(20, 5, 2));
    assertValidPath(map, p);
  });

  it('returns null when the goal is completely walled off', () => {
    const map = createTileMap(20);
    // enclose (10,10) with a ring of blocked tiles (goal itself stays open)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        block(map, 10 + dx, 10 + dy);
      }
    }
    const path = findPathRaw(map, 2, 2, 10, 10);
    expect(path).toBeNull();
  });

  it('routes to the nearest walkable neighbour when the goal tile is blocked', () => {
    const map = createTileMap(20);
    block(map, 10, 10); // a lone tree
    const path = findPathRaw(map, 2, 10, 10, 10);
    expect(path).not.toBeNull();
    const p = path!;
    const lastX = tileXOf(20, p[p.length - 1]);
    const lastY = tileYOf(20, p[p.length - 1]);
    // ends adjacent to the tree, never on it
    expect(Math.max(Math.abs(lastX - 10), Math.abs(lastY - 10))).toBe(1);
    expect(isWalkable(map, lastX, lastY)).toBe(true);
    assertValidPath(map, p);
  });

  it('never cuts corners between two blocked orthogonal tiles', () => {
    const map = createTileMap(20);
    block(map, 5, 4);
    block(map, 4, 5);
    const path = findPathRaw(map, 4, 4, 5, 5);
    expect(path).not.toBeNull();
    const p = path!;
    // the illegal single diagonal step would give length 2; must be longer
    expect(p.length).toBeGreaterThan(2);
    assertValidPath(map, p);
  });

  it('is deterministic across identical calls', () => {
    const map = createTileMap(24);
    block(map, 10, 5);
    block(map, 10, 6);
    block(map, 10, 7);
    const a = findPathRaw(map, 2, 6, 20, 6);
    const b = findPathRaw(map, 2, 6, 20, 6);
    expect(a).not.toBeNull();
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });
});

describe('findPath (version-gated cache)', () => {
  it('serves the cached array on the second identical query', () => {
    const map = createTileMap(20);
    const cache = createPathCache();
    const first = findPath(map, cache, 1, 1, 8, 8);
    expect(first).not.toBeNull();
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);

    const second = findPath(map, cache, 1, 1, 8, 8);
    expect(second).toBe(first); // same cached reference
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it('recomputes after a version bump (stale entries ignored)', () => {
    const map = createTileMap(20);
    const cache = createPathCache();
    findPath(map, cache, 1, 1, 8, 8);
    expect(cache.misses).toBe(1);

    cache.version++; // walkability changed elsewhere
    findPath(map, cache, 1, 1, 8, 8);
    expect(cache.misses).toBe(2); // gate forced a recompute
  });

  it('does not cache unreachable (null) results', () => {
    const map = createTileMap(20);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        map.resourceType[tileIndex(20, 10 + dx, 10 + dy)] = ResourceNode.Tree;
      }
    }
    const cache = createPathCache();
    expect(findPath(map, cache, 2, 2, 10, 10)).toBeNull();
    expect(cache.entries.size).toBe(0);
    expect(findPath(map, cache, 2, 2, 10, 10)).toBeNull();
    expect(cache.misses).toBe(2);
  });
});

describe('tilemap helpers', () => {
  it('isWalkable rejects out-of-bounds, water, resources and occupied tiles', () => {
    const map = createTileMap(10);
    expect(isWalkable(map, 5, 5)).toBe(true);
    expect(isWalkable(map, -1, 5)).toBe(false);
    expect(isWalkable(map, 5, 10)).toBe(false);
    map.terrain[tileIndex(10, 1, 1)] = Terrain.Water;
    expect(isWalkable(map, 1, 1)).toBe(false);
    map.resourceType[tileIndex(10, 2, 2)] = ResourceNode.Tree;
    expect(isWalkable(map, 2, 2)).toBe(false);
    map.occupant[tileIndex(10, 3, 3)] = 42;
    expect(isWalkable(map, 3, 3)).toBe(false);
  });

  it('canPlaceBuilding requires every footprint tile walkable', () => {
    const map = createTileMap(10);
    expect(canPlaceBuilding(map, 4, 4, 2, 2)).toBe(true);
    map.resourceType[tileIndex(10, 5, 5)] = ResourceNode.Tree;
    expect(canPlaceBuilding(map, 4, 4, 2, 2)).toBe(false);
    expect(canPlaceBuilding(map, 9, 9, 2, 2)).toBe(false); // out of bounds
  });

  it('nearestResourceTile returns the closest ring, lowest tile index on ties', () => {
    const map = createTileMap(20);
    const from = tileIndex(20, 5, 4);
    expect(nearestResourceTile(map, from, ResourceNode.Tree, RETARGET_NODE_RADIUS)).toBe(-1);
    // two trees equidistant (Chebyshev 1); (5,3) has lower tile index than (5,5)
    map.resourceType[tileIndex(20, 5, 5)] = ResourceNode.Tree;
    map.resourceType[tileIndex(20, 5, 3)] = ResourceNode.Tree;
    expect(nearestResourceTile(map, from, ResourceNode.Tree, RETARGET_NODE_RADIUS)).toBe(
      tileIndex(20, 5, 3),
    );
    // a closer gold mine wins its own type independently
    map.resourceType[tileIndex(20, 6, 4)] = ResourceNode.GoldMine;
    expect(nearestResourceTile(map, from, ResourceNode.GoldMine, 2)).toBe(tileIndex(20, 6, 4));
    // nothing of that type within radius
    expect(nearestResourceTile(map, from, ResourceNode.StoneMine, 3)).toBe(-1);
  });

  it('adjacentSpawnTile scans south->east->north->west, expanding the ring', () => {
    const map = createTileMap(24);
    // open map: first tile is the south edge west end at (tileX-1, tileY+size)
    expect(adjacentSpawnTile(map, 10, 10, 4, 4)).toBe(tileIndex(24, 9, 14));
    // block that first tile -> next south-edge tile
    map.resourceType[tileIndex(24, 9, 14)] = ResourceNode.Tree;
    expect(adjacentSpawnTile(map, 10, 10, 4, 4)).toBe(tileIndex(24, 10, 14));
  });

  it('adjacentSpawnTile returns -1 when nothing is walkable within 3 rings', () => {
    const map = createTileMap(24);
    // 2x2 building at (10,10); block everything within 3 rings except the footprint
    for (let y = 7; y <= 14; y++) {
      for (let x = 7; x <= 14; x++) {
        const inFoot = x >= 10 && x <= 11 && y >= 10 && y <= 11;
        if (!inFoot) map.resourceType[tileIndex(24, x, y)] = ResourceNode.Tree;
      }
    }
    expect(adjacentSpawnTile(map, 10, 10, 2, 2)).toBe(-1);
  });
});
