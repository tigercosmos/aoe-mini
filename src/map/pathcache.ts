import { tileIndex } from '../shared/constants';
import type { PathCache, TileMap } from '../shared/world';
import { findPathRaw } from './astar';

/** Fresh, empty path cache at version 0. */
export function createPathCache(): PathCache {
  return { version: 0, entries: new Map(), hits: 0, misses: 0 };
}

function tileOf(size: number, x: number, y: number): number {
  let tx = Math.floor(x);
  let ty = Math.floor(y);
  if (tx < 0) tx = 0;
  else if (tx >= size) tx = size - 1;
  if (ty < 0) ty = 0;
  else if (ty >= size) ty = size - 1;
  return tileIndex(size, tx, ty);
}

/**
 * Version-gated memoized pathfinding. The cache key is
 * startTile * (size*size) + goalTile. A cached entry is only reused when its
 * stamped version matches the live cache.version (a walkability change bumps
 * cache.version AND clears entries, so stale paths are never served). On a
 * miss the path is computed with findPathRaw and stored; unreachable results
 * (null) are not cached. The returned array is owned by the cache — callers
 * must not mutate it.
 */
export function findPath(
  map: TileMap,
  cache: PathCache,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
): Uint16Array | null {
  const size = map.size;
  const startTile = tileOf(size, sx, sy);
  const goalTile = tileOf(size, gx, gy);
  const key = startTile * (size * size) + goalTile;

  const entry = cache.entries.get(key);
  if (entry !== undefined && entry.version === cache.version) {
    cache.hits++;
    return entry.path;
  }

  cache.misses++;
  const path = findPathRaw(map, sx, sy, gx, gy);
  if (path !== null) {
    cache.entries.set(key, { version: cache.version, path });
  }
  return path;
}
