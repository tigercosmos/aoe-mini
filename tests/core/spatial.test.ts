import { describe, it, expect } from 'vitest';
import { createSpatialGrid } from '../../src/core/spatial';
import { createEntityManager } from '../../src/core/entities';
import { createComponentStores } from '../../src/core/components';
import { QUERY_BUFFER_SIZE } from '../../src/shared/constants';
import { EntityKind } from '../../src/shared/enums';
import type { EntityManager, ComponentStores } from '../../src/shared/world';

/** Place `n` Unit entities on a 10-wide tile grid at tile-centre coordinates. */
function makeScene(n: number): { em: EntityManager; comp: ComponentStores } {
  const em = createEntityManager(256);
  const comp = createComponentStores(256);
  for (let i = 0; i < n; i++) {
    const idx = em.create();
    comp.kind[idx] = EntityKind.Unit;
    comp.posX[idx] = (i % 10) + 0.5;
    comp.posY[idx] = ((i / 10) | 0) + 0.5;
  }
  return { em, comp };
}

/** Brute-force reference: alive Unit/Building indices within r of (x,y), ascending. */
function refCircle(em: EntityManager, comp: ComponentStores, x: number, y: number, r: number): number[] {
  const res: number[] = [];
  const r2 = r * r;
  for (let i = 0; i < em.capacity; i++) {
    if (em.alive[i] !== 1 || comp.kind[i] === EntityKind.Projectile) continue;
    const dx = comp.posX[i] - x;
    const dy = comp.posY[i] - y;
    if (dx * dx + dy * dy <= r2) res.push(i);
  }
  return res;
}

function toArray(out: Int32Array, n: number): number[] {
  return Array.from(out.subarray(0, n));
}

describe('createSpatialGrid.queryCircle', () => {
  it('returns exactly the in-radius set, ascending, matching brute force', () => {
    const { em, comp } = makeScene(100);
    const grid = createSpatialGrid(16, 4);
    grid.rebuild(em, comp);
    const out = new Int32Array(QUERY_BUFFER_SIZE);

    for (const [cx, cy, r] of [
      [4.5, 4.5, 2.0],
      [0.5, 0.5, 1.5],
      [9.5, 9.5, 3.0],
      [5.0, 5.0, 0.4], // radius smaller than tile spacing -> possibly empty
      [4.5, 4.5, 100], // covers everything
    ] as const) {
      const n = grid.queryCircle(cx, cy, r, out);
      const got = toArray(out, n);
      const expected = refCircle(em, comp, cx, cy, r);
      expect(got).toEqual(expected);
      // Explicitly ascending.
      for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
    }
  });

  it('produces identical results across repeated rebuilds', () => {
    const { em, comp } = makeScene(100);
    const grid = createSpatialGrid(16, 4);
    const out = new Int32Array(QUERY_BUFFER_SIZE);

    grid.rebuild(em, comp);
    const n1 = grid.queryCircle(4.5, 4.5, 3, out);
    const first = toArray(out, n1);

    grid.rebuild(em, comp);
    const n2 = grid.queryCircle(4.5, 4.5, 3, out);
    const second = toArray(out, n2);

    expect(second).toEqual(first);
  });

  it('respects the out-buffer cap (count never exceeds out.length)', () => {
    const { em, comp } = makeScene(100);
    const grid = createSpatialGrid(16, 4);
    grid.rebuild(em, comp);
    const small = new Int32Array(5);
    const n = grid.queryCircle(4.5, 4.5, 100, small); // would match all 100
    expect(n).toBe(5);
    expect(n).toBeLessThanOrEqual(small.length);
    // The 5 captured indices are still sorted ascending.
    const got = toArray(small, n);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
  });

  it('skips Projectile-kind entities', () => {
    const em = createEntityManager(16);
    const comp = createComponentStores(16);
    const a = em.create();
    comp.kind[a] = EntityKind.Unit;
    comp.posX[a] = 2.0; comp.posY[a] = 2.0;
    const proj = em.create();
    comp.kind[proj] = EntityKind.Projectile;
    comp.posX[proj] = 2.0; comp.posY[proj] = 2.0; // same spot as the unit
    const b = em.create();
    comp.kind[b] = EntityKind.Building;
    comp.posX[b] = 2.2; comp.posY[b] = 2.1;

    const grid = createSpatialGrid(16, 4);
    grid.rebuild(em, comp);
    const out = new Int32Array(QUERY_BUFFER_SIZE);
    const n = grid.queryCircle(2.0, 2.0, 1.0, out);
    expect(toArray(out, n)).toEqual([a, b]); // projectile excluded
  });

  it('returns 0 before any rebuild', () => {
    const grid = createSpatialGrid(16, 4);
    const out = new Int32Array(QUERY_BUFFER_SIZE);
    expect(grid.queryCircle(0, 0, 5, out)).toBe(0);
  });

  it('reflects destroyed entities after re-rebuild', () => {
    const { em, comp } = makeScene(100);
    const grid = createSpatialGrid(16, 4);
    const out = new Int32Array(QUERY_BUFFER_SIZE);
    grid.rebuild(em, comp);
    const before = grid.queryCircle(4.5, 4.5, 3, out);
    expect(before).toBeGreaterThan(0);

    // Destroy every entity currently returned, then rebuild.
    const doomed = toArray(out, before);
    for (const idx of doomed) em.destroy(idx);
    grid.rebuild(em, comp);
    const after = grid.queryCircle(4.5, 4.5, 3, out);
    const got = toArray(out, after);
    for (const idx of doomed) expect(got).not.toContain(idx);
  });
});

describe('createSpatialGrid.queryRect', () => {
  it('returns exactly the entities inside the rectangle, ascending', () => {
    const { em, comp } = makeScene(100);
    const grid = createSpatialGrid(16, 4);
    grid.rebuild(em, comp);
    const out = new Int32Array(QUERY_BUFFER_SIZE);

    const minX = 2.0, minY = 2.0, maxX = 5.0, maxY = 5.0;
    const n = grid.queryRect(minX, minY, maxX, maxY, out);
    const got = toArray(out, n);

    const expected: number[] = [];
    for (let i = 0; i < em.capacity; i++) {
      if (em.alive[i] !== 1 || comp.kind[i] === EntityKind.Projectile) continue;
      const px = comp.posX[i], py = comp.posY[i];
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) expected.push(i);
    }
    expect(got).toEqual(expected);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
  });

  it('uses the default cell size when none is given', () => {
    const { em, comp } = makeScene(30);
    const grid = createSpatialGrid(16); // default SPATIAL_CELL_SIZE
    grid.rebuild(em, comp);
    const out = new Int32Array(QUERY_BUFFER_SIZE);
    const n = grid.queryRect(0, 0, 16, 16, out);
    expect(n).toBe(30); // all alive units inside the map
  });
});
