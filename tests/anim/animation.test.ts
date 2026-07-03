// tests/anim/animation.test.ts
// Animation-package regression tests (NEW dir owned by the [animation] worker). These lock
// in the runtime-animation contracts that tests/render/render.test.ts does not exercise:
//   (a) a MOVING unit gets ZERO horizontal offset and only a small vertical bob,
//   (b) a corpse redraws with a sprite key that is ALREADY cached (zero cache growth across
//       a death plus many renders),
//   (c) render() completes with corpses / wood-flecks / footstep dust all active and never
//       touches a ctx method outside the fake's stubbed whitelist.
//
// It re-uses the exact FakeCtx recorder shape from render.test so any un-stubbed ctx call
// throws, and the same headless offscreen-canvas factory swap.

import { describe, it, expect, beforeEach } from 'vitest';
import { EntityKind, UnitType, OrderType } from '../../src/shared/enums';
import { worldToScreen, type Vec2 } from '../../src/shared/iso';
import type { World } from '../../src/shared/world';
import type { ViewState } from '../../src/shared/interfaces';
import {
  spriteKey, getSprite, getSpriteCacheSize, clearSpriteCache, setCanvasFactory,
} from '../../src/render/sprites';
import { createCanvas2DRenderer } from '../../src/render/canvas2d';

interface DrawImageCall { img: unknown; dx: number; dy: number; dw?: number; dh?: number; nargs: number }

class FakeCtx {
  canvas: { width: number; height: number };
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  lineDashOffset = 0;
  drawImageCalls: DrawImageCall[] = [];
  constructor(canvas: { width: number; height: number }) { this.canvas = canvas; }
  clearRect(): void {}
  fillRect(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  ellipse(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  setLineDash(): void {}
  createRadialGradient(): { addColorStop(): void } { return { addColorStop(): void {} }; }
  drawImage(
    img: unknown, a: number, b: number, c?: number, d?: number,
    e?: number, f?: number, g?: number, h?: number,
  ): void {
    if (h !== undefined) this.drawImageCalls.push({ img, dx: e!, dy: f!, dw: g, dh: h, nargs: 9 });
    else this.drawImageCalls.push({ img, dx: a, dy: b, dw: c, dh: d, nargs: 5 });
  }
}

interface FakeCanvas { width: number; height: number; getContext(t: string): FakeCtx }

function makeCanvas(w: number, h: number): FakeCanvas {
  const cv: FakeCanvas = { width: w, height: h } as FakeCanvas;
  const ctx = new FakeCtx(cv);
  cv.getContext = () => ctx;
  return cv;
}

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
    orderType: new Uint8Array(capacity),
    orderTarget: new Int32Array(capacity).fill(-1),
    attackRange: new Float32Array(capacity),
    attackRateTicks: new Float32Array(capacity),
    attackCooldown: new Float32Array(capacity),
    rallyX: new Float32Array(capacity).fill(-1),
    rallyY: new Float32Array(capacity).fill(-1),
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
  return { tick: 0, mapSize: size, em, comp, map } as unknown as World;
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

function revealAll(world: World, player: number, visible: boolean): void {
  for (let ti = 0; ti < world.mapSize * world.mapSize; ti++) {
    world.map.explored[ti] |= (1 << player);
    if (visible) world.map.visible[ti] |= (1 << player);
  }
}

function makeView(overrides: Partial<ViewState> = {}): ViewState {
  return {
    camX: 0, camY: 0, zoom: 1, viewportW: 200, viewportH: 200,
    localPlayer: 1, selection: [], ghost: null, ...overrides,
  };
}

beforeEach(() => {
  clearSpriteCache();
  setCanvasFactory((w, h) => makeCanvas(w, h) as unknown as HTMLCanvasElement);
});

describe('runtime animation', () => {
  it('gives a moving unit zero horizontal offset and a bob within 2px', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 1, 0);
    world.comp.prevX[0] = 0; world.comp.prevY[0] = 0; // moving east
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);
    const view = makeView();
    r.render(world, view, 0.5); // interp (0.5, 0)

    const spr = getSprite(spriteKey(EntityKind.Unit, UnitType.Villager, 1, 0));
    const call = canvas.getContext('2d').drawImageCalls.find((c) => c.img === spr.canvas);
    expect(call).toBeDefined();
    const out: Vec2 = { x: 0, y: 0 };
    worldToScreen(view, 0.5, 0, out);
    expect(call!.dx).toBeCloseTo(out.x - spr.anchorX, 5);          // exactly zero horizontal offset
    expect(Math.abs(call!.dy - (out.y - spr.anchorY))).toBeLessThanOrEqual(2.0); // bob <= 2px
  });

  it('draws a corpse from an already-cached key with no sprite-cache growth', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Militia, 1, 3, 3);
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);

    r.render(world, makeView(), 0);          // unit drawn -> its sprite key is now cached
    const afterAlive = getSpriteCacheSize();
    expect(afterAlive).toBeGreaterThan(0);

    world.em.alive[0] = 0;                    // dies -> becomes a corpse
    world.tick++;
    const corpseKey = spriteKey(EntityKind.Unit, UnitType.Militia, 1, 0);
    for (let f = 0; f < 21; f++) r.render(world, makeView(), 0);

    // The corpse re-uses the exact key the unit last drew with (already cached) and the
    // death dust re-uses warmed FX keys, so the cache never grows.
    expect(getSpriteCacheSize()).toBe(afterAlive);
    const corpseSpr = getSprite(corpseKey);
    expect(getSpriteCacheSize()).toBe(afterAlive); // fetching the corpse key mints nothing new
    // A corpse drawImage of that sprite happened during the post-death frames.
    expect(canvas.getContext('2d').drawImageCalls.some((c) => c.img === corpseSpr.canvas)).toBe(true);
  });

  it('renders gather flecks, footsteps and a build worksite with only stubbed ctx calls', () => {
    const world = makeWorld(8);
    revealAll(world, 1, true);
    addUnit(world, 0, UnitType.Villager, 1, 2, 2);       // chopper (stationary gather)
    world.comp.orderType[0] = OrderType.GatherEntity;
    addUnit(world, 1, UnitType.Villager, 1, 4, 4);       // builder (stationary build)
    world.comp.orderType[1] = OrderType.Build;
    addUnit(world, 2, UnitType.Villager, 1, 6, 6);       // walker (footstep dust)
    const canvas = makeCanvas(200, 200);
    const r = createCanvas2DRenderer();
    r.init(canvas as unknown as HTMLCanvasElement);

    for (let f = 0; f < 12; f++) {
      // Advance the sim clock so chop/build apexes fire, and nudge the walker each tick.
      world.tick++;
      world.comp.prevX[2] = world.comp.posX[2];
      world.comp.posX[2] += 0.4;
      expect(() => r.render(world, makeView(), 0)).not.toThrow();
    }
    expect(canvas.getContext('2d').drawImageCalls.length).toBeGreaterThan(0);
  });
});
