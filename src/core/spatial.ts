import { SPATIAL_CELL_SIZE } from '../shared/constants';
import { EntityKind } from '../shared/enums';
import type { ComponentStores, EntityManager, SpatialGrid } from '../shared/world';

/**
 * Uniform spatial hash grid (T1).
 *
 * Layout is a compressed-sparse-row (CSR) bucketing: `rebuild` counts entities per cell, prefix-
 * sums into `cellStart`, then scatters entity indices into `items` in ASCENDING index order, so
 * each cell's slice is already sorted. Queries gather candidates from the overlapping cells and
 * finish with an in-place insertion sort of the filled `out` prefix, guaranteeing globally
 * ascending output (and therefore identical results across repeated rebuilds).
 *
 * Projectiles are never bucketed (rebuild skips EntityKind.Projectile). Zero per-call allocation:
 * all working arrays are owned by the grid, and query scratch is owned by the caller (`out`).
 */
export function createSpatialGrid(mapSize: number, cellSize: number = SPATIAL_CELL_SIZE): SpatialGrid {
  const cols = Math.max(1, Math.ceil(mapSize / cellSize));
  const numCells = cols * cols;

  // CSR structures. cellStart has numCells+1 slots (last = total inserted).
  const cellStart = new Int32Array(numCells + 1);
  const cursor = new Int32Array(numCells);
  let items: Int32Array | null = null; // sized to em.capacity on first rebuild
  let compRef: ComponentStores | null = null;

  function cellIndex(x: number, y: number): number {
    let cx = (x / cellSize) | 0;
    let cy = (y / cellSize) | 0;
    if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0; else if (cy >= cols) cy = cols - 1;
    return cy * cols + cx;
  }

  function clampCol(v: number): number {
    const c = v | 0;
    if (c < 0) return 0;
    if (c >= cols) return cols - 1;
    return c;
  }

  // Ascending in-place insertion sort of out[0..n).
  function sortPrefix(out: Int32Array, n: number): void {
    for (let i = 1; i < n; i++) {
      const v = out[i];
      let j = i - 1;
      while (j >= 0 && out[j] > v) {
        out[j + 1] = out[j];
        j--;
      }
      out[j + 1] = v;
    }
  }

  const grid: SpatialGrid = {
    cellSize,

    rebuild(em: EntityManager, comp: ComponentStores): void {
      compRef = comp;
      const cap = em.capacity;
      if (items === null || items.length < cap) items = new Int32Array(cap);
      const alive = em.alive;
      const kind = comp.kind;
      const posX = comp.posX;
      const posY = comp.posY;

      // Pass 1: per-cell counts, stored at cellStart[cell+1] ready for the prefix sum.
      cellStart.fill(0);
      for (let i = 0; i < cap; i++) {
        if (alive[i] !== 1 || kind[i] === EntityKind.Projectile) continue;
        cellStart[cellIndex(posX[i], posY[i]) + 1]++;
      }
      // Prefix sum -> cellStart[c] = start offset of cell c; cellStart[numCells] = total.
      for (let c = 0; c < numCells; c++) {
        cellStart[c + 1] += cellStart[c];
        cursor[c] = cellStart[c];
      }
      // Pass 2: scatter ascending so each cell slice is ascending index order.
      for (let i = 0; i < cap; i++) {
        if (alive[i] !== 1 || kind[i] === EntityKind.Projectile) continue;
        const cell = cellIndex(posX[i], posY[i]);
        items[cursor[cell]] = i;
        cursor[cell]++;
      }
    },

    queryCircle(x: number, y: number, r: number, out: Int32Array): number {
      if (compRef === null || items === null) return 0;
      const posX = compRef.posX;
      const posY = compRef.posY;
      const cap = out.length;
      const r2 = r * r;
      const minCx = clampCol((x - r) / cellSize);
      const maxCx = clampCol((x + r) / cellSize);
      const minCy = clampCol((y - r) / cellSize);
      const maxCy = clampCol((y + r) / cellSize);
      let count = 0;
      for (let cy = minCy; cy <= maxCy; cy++) {
        const rowBase = cy * cols;
        for (let cx = minCx; cx <= maxCx; cx++) {
          const cell = rowBase + cx;
          const end = cellStart[cell + 1];
          for (let k = cellStart[cell]; k < end; k++) {
            const idx = items[k];
            const dx = posX[idx] - x;
            const dy = posY[idx] - y;
            if (dx * dx + dy * dy <= r2) {
              if (count >= cap) {
                sortPrefix(out, count);
                return count;
              }
              out[count] = idx;
              count++;
            }
          }
        }
      }
      sortPrefix(out, count);
      return count;
    },

    queryRect(minX: number, minY: number, maxX: number, maxY: number, out: Int32Array): number {
      if (compRef === null || items === null) return 0;
      const posX = compRef.posX;
      const posY = compRef.posY;
      const cap = out.length;
      const minCx = clampCol(minX / cellSize);
      const maxCx = clampCol(maxX / cellSize);
      const minCy = clampCol(minY / cellSize);
      const maxCy = clampCol(maxY / cellSize);
      let count = 0;
      for (let cy = minCy; cy <= maxCy; cy++) {
        const rowBase = cy * cols;
        for (let cx = minCx; cx <= maxCx; cx++) {
          const cell = rowBase + cx;
          const end = cellStart[cell + 1];
          for (let k = cellStart[cell]; k < end; k++) {
            const idx = items[k];
            const px = posX[idx];
            const py = posY[idx];
            if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
              if (count >= cap) {
                sortPrefix(out, count);
                return count;
              }
              out[count] = idx;
              count++;
            }
          }
        }
      }
      sortPrefix(out, count);
      return count;
    },
  };
  return grid;
}
