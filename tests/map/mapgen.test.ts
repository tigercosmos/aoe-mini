import { describe, expect, it } from 'vitest';
import { tileIndex } from '../../src/shared/constants';
import { ResourceNode } from '../../src/shared/enums';
import { createRng } from '../../src/shared/rng';
import type { TileMap } from '../../src/shared/world';
import { generateMap } from '../../src/map/mapgen';
import { createTileMap, isWalkable } from '../../src/map/tilemap';

const SIZE = 64;
const PLAYERS = 3;

function gen(seed: number): { map: TileMap; starts: { x: number; y: number }[]; sheep: { x: number; y: number }[] } {
  const map = createTileMap(SIZE);
  const res = generateMap(map, createRng(seed), PLAYERS);
  return { map, starts: res.starts, sheep: res.sheep };
}

function centerOf(s: { x: number; y: number }): { x: number; y: number } {
  return { x: s.x + 2, y: s.y + 2 }; // Town Center footprint centre
}

function hasNodeWithin(map: TileMap, cx: number, cy: number, r: number, node: ResourceNode): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.size || y >= map.size) continue;
      if (map.resourceType[tileIndex(map.size, x, y)] === node) return true;
    }
  }
  return false;
}

/** 4-connected flood fill over walkable tiles from (sx,sy). */
function reachable(map: TileMap, sx: number, sy: number): Uint8Array {
  const size = map.size;
  const seen = new Uint8Array(size * size);
  const stack: number[] = [tileIndex(size, sx, sy)];
  seen[tileIndex(size, sx, sy)] = 1;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  while (stack.length > 0) {
    const t = stack.pop()!;
    const x = t % size;
    const y = (t / size) | 0;
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isWalkable(map, nx, ny)) continue;
      const nt = tileIndex(size, nx, ny);
      if (seen[nt] === 1) continue;
      seen[nt] = 1;
      stack.push(nt);
    }
  }
  return seen;
}

describe('generateMap', () => {
  it('is byte-identical across two runs with the same seed', () => {
    const a = gen(42);
    const b = gen(42);
    expect(Array.from(a.map.terrain)).toEqual(Array.from(b.map.terrain));
    expect(Array.from(a.map.resourceType)).toEqual(Array.from(b.map.resourceType));
    expect(Array.from(a.map.resourceAmount)).toEqual(Array.from(b.map.resourceAmount));
    expect(a.starts).toEqual(b.starts);
    expect(a.sheep).toEqual(b.sheep);
  });

  it('diverges for different seeds', () => {
    const a = gen(42);
    const b = gen(7);
    expect(Array.from(a.map.resourceType)).not.toEqual(Array.from(b.map.resourceType));
  });

  it('places starts at least 25 tiles apart', () => {
    const { starts } = gen(42);
    expect(starts.length).toBe(PLAYERS);
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        const dx = starts[i].x - starts[j].x;
        const dy = starts[i].y - starts[j].y;
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('gives each start >=4 sheep and forage/gold/stone within 15 tiles', () => {
    const { map, starts, sheep } = gen(42);
    expect(sheep.length).toBe(PLAYERS * 4);
    for (const s of starts) {
      const c = centerOf(s);
      const nearSheep = sheep.filter((sp) => Math.hypot(sp.x - c.x, sp.y - c.y) <= 15).length;
      expect(nearSheep).toBeGreaterThanOrEqual(4);
      expect(hasNodeWithin(map, c.x, c.y, 15, ResourceNode.Forage)).toBe(true);
      expect(hasNodeWithin(map, c.x, c.y, 15, ResourceNode.GoldMine)).toBe(true);
      expect(hasNodeWithin(map, c.x, c.y, 15, ResourceNode.StoneMine)).toBe(true);
    }
  });

  it('keeps the Town Center footprint clear/walkable', () => {
    const { map, starts } = gen(42);
    for (const s of starts) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          expect(isWalkable(map, s.x + dx, s.y + dy)).toBe(true);
        }
      }
    }
  });

  it('guarantees all starts are mutually reachable', () => {
    const { map, starts } = gen(42);
    const c0 = centerOf(starts[0]);
    const seen = reachable(map, c0.x, c0.y);
    for (let i = 1; i < starts.length; i++) {
      const ci = centerOf(starts[i]);
      expect(seen[tileIndex(map.size, ci.x, ci.y)]).toBe(1);
    }
  });
});
