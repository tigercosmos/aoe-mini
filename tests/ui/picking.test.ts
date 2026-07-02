/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { pickTile, pickEntity, entitiesInScreenRect } from '../../src/ui/picking';
import { worldToScreen } from '../../src/shared/iso';
import type { Vec2 } from '../../src/shared/iso';
import { EntityKind } from '../../src/shared/enums';
import { makeHandle } from '../../src/shared/world';
import type { World } from '../../src/shared/world';
import type { ViewState } from '../../src/shared/interfaces';
import { tileIndex, inBounds } from '../../src/shared/constants';

// ---- minimal standalone fake world (shared contracts only; no sibling imports) ----
interface Fake {
  world: World;
  spawn(kind: number, subtype: number, owner: number, x: number, y: number, radius: number, sx: number, sy: number): number;
  explore(tx: number, ty: number, player: number): void;
}

function makeWorld(size: number, cap = 64): Fake {
  const alive = new Uint8Array(cap);
  const generation = new Uint16Array(cap);
  const kind = new Uint8Array(cap);
  const subtype = new Uint16Array(cap);
  const owner = new Uint8Array(cap);
  const posX = new Float32Array(cap);
  const posY = new Float32Array(cap);
  const radius = new Float32Array(cap);
  const sizeX = new Uint8Array(cap);
  const sizeY = new Uint8Array(cap);
  const explored = new Uint8Array(size * size);

  const em = {
    capacity: cap,
    aliveCount: 0,
    alive,
    generation,
    create(): number {
      for (let i = 0; i < cap; i++) {
        if (alive[i] === 0) {
          alive[i] = 1;
          this.aliveCount++;
          return i;
        }
      }
      throw new Error('entity capacity exceeded');
    },
    destroy(i: number): void {
      alive[i] = 0;
      generation[i]++;
      this.aliveCount--;
    },
    isAlive(i: number): boolean {
      return alive[i] === 1;
    },
    handleFor(i: number): number {
      return makeHandle(i, generation[i]);
    },
  };

  const grid = {
    cellSize: 4,
    rebuild(): void {},
    queryCircle(x: number, y: number, r: number, out: Int32Array): number {
      let c = 0;
      const r2 = r * r;
      for (let i = 0; i < cap; i++) {
        if (alive[i] !== 1) continue;
        if (kind[i] === EntityKind.Projectile) continue;
        const dx = posX[i] - x;
        const dy = posY[i] - y;
        if (dx * dx + dy * dy <= r2) {
          if (c < out.length) out[c] = i;
          c++;
        }
      }
      return c;
    },
    queryRect(): number {
      return 0;
    },
  };

  const comp = { capacity: cap, kind, subtype, owner, posX, posY, radius, sizeX, sizeY } as unknown;
  const map = { size, explored } as unknown;
  const world = { mapSize: size, em, comp, map, grid } as unknown as World;

  return {
    world,
    spawn(k, st, own, x, y, rad, sx, sy): number {
      const i = em.create();
      kind[i] = k;
      subtype[i] = st;
      owner[i] = own;
      posX[i] = x;
      posY[i] = y;
      radius[i] = rad;
      sizeX[i] = sx;
      sizeY[i] = sy;
      return i;
    },
    explore(tx, ty, player): void {
      if (inBounds(size, tx, ty)) explored[tileIndex(size, tx, ty)] |= 1 << player;
    },
  };
}

function makeView(size: number): ViewState {
  return {
    camX: size / 2,
    camY: size / 2,
    zoom: 1,
    viewportW: 800,
    viewportH: 600,
    localPlayer: 1,
    selection: [],
    ghost: null,
  };
}

describe('pickTile', () => {
  it('round-trips a world point through worldToScreen back to the correct tile', () => {
    const size = 96;
    const view = makeView(size);
    const p: Vec2 = { x: 0, y: 0 };
    // Center of tile (10,10) is world (10.5, 10.5).
    worldToScreen(view, 10.5, 10.5, p);
    expect(pickTile(view, p.x, p.y, size)).toBe(tileIndex(size, 10, 10));
  });

  it('returns -1 off the map', () => {
    const size = 96;
    const view = makeView(size);
    const p: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, -50, -50, p);
    expect(pickTile(view, p.x, p.y, size)).toBe(-1);
  });
});

describe('pickEntity', () => {
  it('picks the entity at its own screen position and not one three tiles away', () => {
    const size = 96;
    const f = makeWorld(size);
    const view = makeView(size);
    const idx = f.spawn(EntityKind.Unit, 0, 1, 10, 10, 0.3, 0, 0); // villager at (10,10)
    f.explore(10, 10, 1);
    const handle = f.world.em.handleFor(idx);

    const p: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, 10, 10, p);
    expect(pickEntity(f.world, view, p.x, p.y)).toBe(handle);

    // Three tiles east: outside the 1.5 query radius -> nothing picked.
    worldToScreen(view, 13, 10, p);
    expect(pickEntity(f.world, view, p.x, p.y)).toBe(-1);
  });

  it('prefers units over buildings under the same cursor point', () => {
    const size = 96;
    const f = makeWorld(size);
    const view = makeView(size);
    f.spawn(EntityKind.Building, 0, 1, 20, 20, 0, 4, 4); // TC footprint centered at (20,20)
    const unitIdx = f.spawn(EntityKind.Unit, 0, 1, 20, 20, 0.3, 0, 0); // villager on top
    f.explore(20, 20, 1);
    const unitHandle = f.world.em.handleFor(unitIdx);

    const p: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, 20, 20, p);
    expect(pickEntity(f.world, view, p.x, p.y)).toBe(unitHandle);
  });

  it('does not pick entities on unexplored tiles', () => {
    const size = 96;
    const f = makeWorld(size);
    const view = makeView(size);
    f.spawn(EntityKind.Unit, 0, 1, 10, 10, 0.3, 0, 0); // not explored
    const p: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, 10, 10, p);
    expect(pickEntity(f.world, view, p.x, p.y)).toBe(-1);
  });
});

describe('entitiesInScreenRect', () => {
  it('returns only own units, ascending, excluding buildings and enemy units', () => {
    const size = 96;
    const f = makeWorld(size);
    const view = makeView(size);
    // Two own units near the camera center, one enemy unit, one own building.
    const u1 = f.spawn(EntityKind.Unit, 0, 1, 48, 48, 0.3, 0, 0);
    const u2 = f.spawn(EntityKind.Unit, 0, 1, 47.5, 48.5, 0.3, 0, 0);
    f.spawn(EntityKind.Unit, 0, 2, 48, 48, 0.3, 0, 0); // enemy unit
    f.spawn(EntityKind.Building, 0, 1, 48, 48, 0, 4, 4); // own building

    const picked = entitiesInScreenRect(f.world, view, 0, 0, view.viewportW, view.viewportH, 1);
    const h1 = f.world.em.handleFor(u1);
    const h2 = f.world.em.handleFor(u2);
    expect(picked).toEqual([h1, h2].sort((a, b) => a - b));
  });
});
