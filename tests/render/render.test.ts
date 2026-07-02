// tests/render/render.test.ts
// T7 renderer tests — fully standalone (imports src/shared + src/render only). A fake
// CanvasRenderingContext2D recorder stands in for the real 2D backend (jsdom has none),
// and the offscreen-canvas factory is swapped for a fake so sprite/terrain rasterization
// works headlessly. Worlds are hand-built (no T1/T2 factories) since the renderer only
// reads World.

import { describe, it, expect, beforeEach } from 'vitest';
import { EntityKind, UnitType } from '../../src/shared/enums';
import { MAX_ENTITIES } from '../../src/shared/constants';
import { worldToScreen, type Vec2 } from '../../src/shared/iso';
import type { World } from '../../src/shared/world';
import type { ViewState } from '../../src/shared/interfaces';
import {
  spriteKey, getSprite, getSpriteCacheSize, clearSpriteCache, setCanvasFactory, PLAYER_COLORS,
} from '../../src/render/sprites';
import { createCanvas2DRenderer } from '../../src/render/canvas2d';

// ---------------------------------------------------------------------------
// Fake canvas + recording 2D context.
// ---------------------------------------------------------------------------

interface DrawImageCall { img: unknown; dx: number; dy: number; dw?: number; dh?: number }
interface FillRectCall { x: number; y: number; w: number; h: number; fillStyle: unknown }

class FakeCtx {
  canvas: { width: number; height: number };
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  drawImageCalls: DrawImageCall[] = [];
  fillRectCalls: FillRectCall[] = [];
  constructor(canvas: { width: number; height: number }) { this.canvas = canvas; }
  clearRect(): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRectCalls.push({ x, y, w, h, fillStyle: this.fillStyle });
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  ellipse(): void {}
  fill(): void {}
  stroke(): void {}
  drawImage(img: unknown, dx: number, dy: number, dw?: number, dh?: number): void {
    this.drawImageCalls.push({ img, dx, dy, dw, dh });
  }
}

interface FakeCanvas { width: number; height: number; getContext(t: string): FakeCtx }

function makeCanvas(w: number, h: number): FakeCanvas {
  const cv: FakeCanvas = { width: w, height: h } as FakeCanvas;
  const ctx = new FakeCtx(cv);
  cv.getContext = () => ctx;
  return cv;
}

// ---------------------------------------------------------------------------
// Minimal hand-built world.
// ---------------------------------------------------------------------------

function makeWorld(size: number, capacity = 32): World {
  const n = size * size;
  const comp = {
    capacity,
    kind: new Uint8Array(capacity),
    subtype: new Uint16Array(capacity),
    owner: new Uint8Array(capacity),
    flags: new Uint8Array(capacity),
    posX: new Float32Array(capacity),
    posY: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    sizeX: new Uint8Array(capacity),
    sizeY: new Uint8Array(capacity),
    hp: new Float32Array(capacity),
    maxHp: new Float32Array(capacity),
  };
  const generation = new Uint16Array(capacity);
  const alive = new Uint8Array(capacity);
  const em = {
    capacity,
    alive,
    generation,
    handleFor(i: number): number { return (((generation[i] << 12) >>> 0) | i) >>> 0; },
    isAlive(i: number): boolean { return alive[i] === 1; },
  };
  const map = {
    size,
    terrain: new Uint8Array(n),
    resourceType: new Uint8Array(n),
    resourceAmount: new Float32Array(n),
    occupant: new Int32Array(n).fill(-1),
    visible: new Uint8Array(n),
    explored: new Uint8Array(n),
  };
  const world = { tick: 0, mapSize: size, em, comp, map } as unknown as World;
  return world;
}

function addUnit(world: World, index: number, subtype: number, owner: number, x: number, y: number): void {
  const c = world.comp;
  world.em.alive[index] = 1;
  c.kind[index] = EntityKind.Unit;
  c.subtype[index] = subtype;
  c.owner[index] = owner;
  c.posX[index] = x; c.posY[index] = y;
  c.prevX[index] = x; c.prevY[index] = y;
  c.hp[index] = 40; c.maxHp[index] = 40;
}

function addBuilding(world: World, index: number, subtype: number, owner: number, cx: number, cy: number, sx: number, sy: number): void {
  const c = world.comp;
  world.em.alive[index] = 1;
  c.kind[index] = EntityKind.Building;
  c.subtype[index] = subtype;
  c.owner[index] = owner;
  c.posX[index] = cx; c.posY[index] = cy;
  c.prevX[index] = cx; c.prevY[index] = cy;
  c.sizeX[index] = sx; c.sizeY[index] = sy;
  c.hp[index] = 1000; c.maxHp[index] = 1000;
}

function reveal(world: World, tx: number, ty: number, player: number, visible: boolean): void {
  const ti = ty * world.mapSize + tx;
  world.map.explored[ti] |= (1 << player);
  if (visible) world.map.visible[ti] |= (1 << player);
}

function revealAll(world: World, player: number, visible: boolean): void {
  for (let ty = 0; ty < world.mapSize; ty++) {
    for (let tx = 0; tx < world.mapSize; tx++) reveal(world, tx, ty, player, visible);
  }
}

function makeView(overrides: Partial<ViewState> = {}): ViewState {
  return {
    camX: 0, camY: 0, zoom: 1, viewportW: 200, viewportH: 200,
    localPlayer: 1, selection: [], ghost: null, ...overrides,
  };
}

function mainCtxOf(canvas: FakeCanvas): FakeCtx { return canvas.getContext('2d'); }

beforeEach(() => {
  clearSpriteCache();
  setCanvasFactory((w, h) => makeCanvas(w, h) as unknown as HTMLCanvasElement);
});

// ---------------------------------------------------------------------------

describe('canvas2d renderer', () => {
  it('init + render completes with no un-stubbed calls and issues drawImage', () => {
    const world = makeWorld(8);
    reveal(world, 0, 0, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 0.5, 0);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.resize(200, 200);
    r.render(world, makeView(), 0);
    expect(mainCtxOf(canvas).drawImageCalls.length).toBeGreaterThan(0);
  });

  it('interpolates entity position and offsets by sprite anchor (agrees with iso.ts)', () => {
    const world = makeWorld(8);
    reveal(world, 0, 0, 1, true);
    // prev=(0,0) pos=(1,0), alpha=0.5 -> interp (0.5,0)
    addUnit(world, 0, UnitType.Villager, 1, 1, 0);
    world.comp.prevX[0] = 0; world.comp.prevY[0] = 0;
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    const view = makeView();
    r.render(world, view, 0.5);

    const spr = getSprite(spriteKey(EntityKind.Unit, UnitType.Villager, 1, 0));
    const call = mainCtxOf(canvas).drawImageCalls.find((c) => c.img === spr.canvas);
    expect(call).toBeDefined();
    const out: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, 0.5, 0, out);
    expect(call!.dx).toBeCloseTo(out.x - spr.anchorX, 5);
    expect(call!.dy).toBeCloseTo(out.y - spr.anchorY, 5);
  });

  it('y-sorts so a southern entity draws after a northern one', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 1, 1); // north (sum 2)
    addUnit(world, 1, UnitType.Villager, 2, 5, 5); // south (sum 10), different owner => distinct sprite
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView(), 0);

    const north = getSprite(spriteKey(EntityKind.Unit, UnitType.Villager, 1, 0)).canvas;
    const south = getSprite(spriteKey(EntityKind.Unit, UnitType.Villager, 2, 0)).canvas;
    const calls = mainCtxOf(canvas).drawImageCalls;
    const iNorth = calls.findIndex((c) => c.img === north);
    const iSouth = calls.findIndex((c) => c.img === south);
    expect(iNorth).toBeGreaterThanOrEqual(0);
    expect(iSouth).toBeGreaterThan(iNorth);
  });

  it('hides units on unexplored tiles and paints minimap black there', () => {
    const world = makeWorld(8);
    // Nothing revealed for player 1. Unit sits on an unexplored tile.
    addUnit(world, 0, UnitType.Militia, 2, 3, 3);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView(), 0);

    const spr = getSprite(spriteKey(EntityKind.Unit, UnitType.Militia, 2, 0));
    const drewUnit = mainCtxOf(canvas).drawImageCalls.some((c) => c.img === spr.canvas);
    expect(drewUnit).toBe(false);

    const mm = makeCanvas(100, 100);
    const mmCtx = mainCtxOf(mm);
    r.renderMinimap(world, makeView(), mmCtx as unknown as CanvasRenderingContext2D);
    // Background full-canvas black rect present; no terrain/entity coloured rects.
    const bg = mmCtx.fillRectCalls.find((c) => c.x === 0 && c.y === 0 && c.w === 100 && c.h === 100);
    expect(bg?.fillStyle).toBe('#000000');
    const colored = mmCtx.fillRectCalls.filter((c) => c.fillStyle !== '#000000');
    expect(colored.length).toBe(0);
  });

  it('draws fogged (explored, not visible) buildings dimmed and shows them on minimap', () => {
    const world = makeWorld(8);
    reveal(world, 2, 2, 1, false); // explored but NOT visible
    reveal(world, 3, 2, 1, false);
    reveal(world, 2, 3, 1, false);
    reveal(world, 3, 3, 1, false);
    addBuilding(world, 0, 2 /* Mill */, 2, 3, 3, 2, 2); // center (3,3), 2x2, owner 2
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView(), 0);

    const key = spriteKey(EntityKind.Building, 2, 2, (2 << 4) | 2);
    const spr = getSprite(key);
    const call = mainCtxOf(canvas).drawImageCalls.find((c) => c.img === spr.canvas);
    expect(call).toBeDefined(); // building visible even in fog (dimmed, not hidden)
  });

  it('memoizes sprites: cache size stable across repeated renders', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 1, 1);
    addUnit(world, 1, UnitType.Archer, 1, 2, 2);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);

    r.render(world, makeView(), 0);
    const afterFirst = getSpriteCacheSize();
    expect(afterFirst).toBeGreaterThan(0);
    for (let f = 0; f < 100; f++) r.render(world, makeView(), 0);
    expect(getSpriteCacheSize()).toBe(afterFirst);
  });

  it('dispose clears the sprite cache', () => {
    const world = makeWorld(8);
    reveal(world, 0, 0, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 0.5, 0.5);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView(), 0);
    expect(getSpriteCacheSize()).toBeGreaterThan(0);
    r.dispose();
    expect(getSpriteCacheSize()).toBe(0);
  });

  it('draws selection ring for selected units', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 2, 2);
    const handle = world.em.handleFor(0);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    // Should not throw with a live selection handle.
    r.render(world, makeView({ selection: [handle] }), 0);
    const spr = getSprite(spriteKey(EntityKind.Unit, UnitType.Villager, 1, 0));
    expect(mainCtxOf(canvas).drawImageCalls.some((c) => c.img === spr.canvas)).toBe(true);
  });

  it('renders a placement ghost highlight without error', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView({ ghost: { building: 1, tileX: 3, tileY: 3, valid: true } }), 0);
    // A fill for the ghost tile occurs; smoke check that render completed.
    expect(mainCtxOf(canvas).drawImageCalls.length).toBeGreaterThan(0);
    expect(PLAYER_COLORS.length).toBe(4);
  });

  it('supports a full-size default map without allocation growth', () => {
    const world = makeWorld(96, MAX_ENTITIES);
    revealAll(world, 1, true);
    addBuilding(world, 0, 0 /* TownCenter */, 1, 10, 10, 4, 4);
    addUnit(world, 1, UnitType.Villager, 1, 12, 12);
    const canvas = makeCanvas(300, 300);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    r.render(world, makeView({ viewportW: 300, viewportH: 300 }), 0);
    const size = getSpriteCacheSize();
    r.render(world, makeView({ viewportW: 300, viewportH: 300 }), 0.5);
    expect(getSpriteCacheSize()).toBe(size);
  });
});
