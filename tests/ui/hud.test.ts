/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
// IMPORTANT: install a fake offscreen-canvas factory BEFORE anything can touch the sprite atlas, so
// the (lazy) portrait path never hits jsdom's missing 2D backend. hud.ts touches sprites only inside
// portraitCanvas (never at import time), so importing createHud below is safe after this runs.
import { setCanvasFactory } from '../../src/render/sprites';

setCanvasFactory((w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  // Provide a minimal 2D stub so getSprite()'s rasterizer never throws in jsdom.
  const noop = (): void => {};
  const ctx = {
    canvas: c,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'round' as CanvasLineJoin,
    imageSmoothingEnabled: false,
    clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    quadraticCurveTo: noop, drawImage: noop, setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
  (c as unknown as { getContext: () => CanvasRenderingContext2D }).getContext = () => ctx;
  return c as unknown as HTMLCanvasElement;
});

import { createHud } from '../../src/ui/hud';
import type { Hud } from '../../src/ui/hud';
import { minimapToWorld } from '../../src/ui/input';
import type { World } from '../../src/shared/world';
import type { ViewState } from '../../src/shared/interfaces';
import type { Command } from '../../src/shared/commands';
import { makeHandle } from '../../src/shared/world';
import { EntityKind, UnitType, BuildingType, ResourceNode, OrderType, Resource } from '../../src/shared/enums';
import { TECH_COUNT } from '../../src/shared/enums';

// ---- minimal fake world compatible with content/stats (needs civ/researched/statsVersion) ----

interface Fake {
  world: World;
  view: ViewState;
  spawnUnit(subtype: number, owner: number, x: number, y: number, orderType?: number, orderTile?: number): number;
  spawnBuilding(subtype: number, owner: number, x: number, y: number, sizeX: number, sizeY: number): number;
  handleFor(i: number): number;
  setResources(player: number, food: number, wood: number, gold: number, stone: number): void;
}

function makeWorld(size = 96, cap = 64): Fake {
  const alive = new Uint8Array(cap);
  const generation = new Uint16Array(cap);
  const kind = new Uint8Array(cap);
  const subtype = new Uint16Array(cap);
  const owner = new Uint8Array(cap);
  const flags = new Uint8Array(cap);
  const posX = new Float32Array(cap);
  const posY = new Float32Array(cap);
  const hp = new Float32Array(cap);
  const maxHp = new Float32Array(cap);
  const attack = new Float32Array(cap);
  const attackRange = new Float32Array(cap);
  const meleeArmor = new Float32Array(cap);
  const pierceArmor = new Float32Array(cap);
  const los = new Float32Array(cap);
  const orderType = new Uint8Array(cap);
  const orderTile = new Int32Array(cap).fill(-1);
  const carryType = new Uint8Array(cap);
  const carryAmount = new Float32Array(cap);
  const buildProgress = new Float32Array(cap);
  const sizeX = new Uint8Array(cap);
  const sizeY = new Uint8Array(cap);
  const queue: (null)[] = new Array(cap).fill(null);

  const resourceType = new Uint8Array(size * size);

  const em = {
    capacity: cap,
    aliveCount: 0,
    alive,
    generation,
    create(): number {
      for (let i = 0; i < cap; i++) if (alive[i] === 0) { alive[i] = 1; this.aliveCount++; return i; }
      throw new Error('capacity');
    },
    destroy(i: number): void { alive[i] = 0; generation[i]++; this.aliveCount--; },
    isAlive(i: number): boolean { return alive[i] === 1; },
    handleFor(i: number): number { return makeHandle(i, generation[i]); },
  };

  function makePlayer(id: number): unknown {
    return {
      id,
      civ: 0, // Britons
      isAI: id !== 1,
      alive: true,
      resources: new Float32Array([1000, 1000, 1000, 1000]),
      population: 5,
      populationCap: 15,
      age: 0,
      researched: new Uint8Array(TECH_COUNT),
      statsVersion: 0,
    };
  }

  const players = [makePlayer(0), makePlayer(1), makePlayer(2), makePlayer(3)];
  const comp = {
    capacity: cap, kind, subtype, owner, flags, posX, posY, hp, maxHp, attack, attackRange,
    meleeArmor, pierceArmor, los, orderType, orderTile, carryType, carryAmount, buildProgress,
    sizeX, sizeY, queue,
  } as unknown;
  const map = { size, resourceType } as unknown;
  const world = { tick: 0, mapSize: size, em, comp, map, players } as unknown as World;

  const view: ViewState = {
    camX: size / 2, camY: size / 2, zoom: 1, viewportW: 800, viewportH: 600,
    localPlayer: 1, selection: [], ghost: null,
  };

  return {
    world,
    view,
    spawnUnit(st, own, x, y, ot = OrderType.Idle, otile = -1): number {
      const i = em.create();
      kind[i] = EntityKind.Unit; subtype[i] = st; owner[i] = own; posX[i] = x; posY[i] = y;
      hp[i] = 40; maxHp[i] = 40; los[i] = 4; orderType[i] = ot; orderTile[i] = otile;
      return i;
    },
    spawnBuilding(st, own, x, y, sx, sy): number {
      const i = em.create();
      kind[i] = EntityKind.Building; subtype[i] = st; owner[i] = own; posX[i] = x; posY[i] = y;
      hp[i] = 1200; maxHp[i] = 1200; los[i] = 5; sizeX[i] = sx; sizeY[i] = sy;
      return i;
    },
    handleFor: (i) => em.handleFor(i),
    setResources(p, f, w, g, s): void {
      (players[p] as { resources: Float32Array }).resources.set([f, w, g, s]);
    },
  };
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

function makeSink(): { fn: (c: Command) => void; cmds: Command[] } {
  const cmds: Command[] = [];
  return { fn: (c) => cmds.push(c), cmds };
}

describe('hud top bar', () => {
  it('renders the game clock, per-resource villager counts and idle badge', () => {
    const f = makeWorld();
    f.world.tick = 1800; // 90s => 1:30
    // Two idle villagers + one gathering wood.
    f.spawnUnit(UnitType.Villager, 1, 20, 20);
    f.spawnUnit(UnitType.Villager, 1, 21, 21);
    const woodTile = 10 * f.world.mapSize + 10;
    (f.world.map.resourceType as Uint8Array)[woodTile] = ResourceNode.Tree;
    f.spawnUnit(UnitType.Villager, 1, 30, 30, OrderType.GatherTile, woodTile);

    const sink = makeSink();
    const hud: Hud = createHud(root, 1, sink.fn, f.view);
    hud.setAutoPlay(false);
    hud.update(f.world, f.view, []);

    expect(root.querySelector('.hud-clock')?.textContent).toBe('1:30');
    expect(root.querySelector('.hud-idle-count')?.textContent).toBe('2');
    expect(root.querySelector('.hud-idle')?.classList.contains('hud-idle-some')).toBe(true);
    // Wood is Resource index 1 -> the 2nd resource cell shows one villager.
    const villSpans = root.querySelectorAll('.hud-res-vill');
    expect(villSpans[Resource.Wood].textContent).toContain('1');
    expect(villSpans[Resource.Food].textContent).toBe('');
  });
});

describe('hud command grid', () => {
  it('a barracks hotkey (q) emits a train command via the sink in manual mode', () => {
    const f = makeWorld();
    const b = f.spawnBuilding(BuildingType.Barracks, 1, 40, 40, 3, 3);

    const sink = makeSink();
    const hud: Hud = createHud(root, 1, sink.fn, f.view);
    hud.setAutoPlay(false); // switching to manual clears the selection...
    f.view.selection = [f.handleFor(b)]; // ...so select the barracks afterwards
    hud.update(f.world, f.view, []);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));

    const train = sink.cmds.find((c) => c.type === 'train');
    expect(train).toBeDefined();
    if (train && train.type === 'train') {
      expect(train.building).toBe(f.handleFor(b));
      expect(train.unit).toBe(UnitType.Militia); // barracks' first Dark-age trainable
    }
  });

  it('marks a cost chip red (hud-cost-no) when the resource is short', () => {
    const f = makeWorld();
    const b = f.spawnBuilding(BuildingType.Barracks, 1, 40, 40, 3, 3);
    f.setResources(1, 0, 0, 0, 0); // can't afford anything

    const sink = makeSink();
    const hud: Hud = createHud(root, 1, sink.fn, f.view);
    hud.setAutoPlay(false);
    f.view.selection = [f.handleFor(b)];
    hud.update(f.world, f.view, []);

    expect(root.querySelector('.hud-cost-no')).not.toBeNull();
  });
});

describe('minimapToWorld inverse projection', () => {
  // Forward projection copied verbatim from render/minimap.ts project() (spec §3.4 frozen formula).
  function project(wx: number, wy: number, size: number, W: number, H: number): { x: number; y: number } {
    const denom = size > 1 ? 2 * (size - 1) : 1;
    return { x: ((wx - wy + (size - 1)) / denom) * W, y: ((wx + wy) / denom) * H };
  }

  it('round-trips project() at size 96 for corners, center and random points', () => {
    const size = 96;
    const W = 200;
    const H = 200;
    const pts: [number, number][] = [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
      [(size - 1) / 2, (size - 1) / 2],
      [17, 63],
      [80.5, 12.25],
      [3, 91],
    ];
    const out = { x: 0, y: 0 };
    for (const [wx, wy] of pts) {
      const m = project(wx, wy, size, W, H);
      minimapToWorld(m.x, m.y, W, H, size, out);
      expect(out.x).toBeCloseTo(wx, 6);
      expect(out.y).toBeCloseTo(wy, 6);
    }
  });
});
