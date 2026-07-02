/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import { createInputController } from '../../src/ui/input';
import type { InputController } from '../../src/shared/interfaces';
import type { World } from '../../src/shared/world';
import { makeHandle } from '../../src/shared/world';
import { EntityKind, UnitType, GAIA } from '../../src/shared/enums';
import { tileIndex, inBounds } from '../../src/shared/constants';

// ---- minimal fake world (shared contracts only; input.ts pulls canPlaceBuilding/resolveCost from
// siblings, so this suite becomes green at the integration pass once those modules exist) ----
interface Fake {
  world: World;
  spawn(kind: number, subtype: number, owner: number, x: number, y: number): number;
  handleFor(i: number): number;
  explore(tx: number, ty: number, player: number): void;
  occupy(tx: number, ty: number, handle: number): void;
}

function makeWorld(size: number, cap = 64): Fake {
  const alive = new Uint8Array(cap);
  const generation = new Uint16Array(cap);
  const kind = new Uint8Array(cap);
  const subtype = new Uint16Array(cap);
  const owner = new Uint8Array(cap);
  const flags = new Uint8Array(cap);
  const posX = new Float32Array(cap);
  const posY = new Float32Array(cap);
  const radius = new Float32Array(cap);
  const sizeX = new Uint8Array(cap);
  const sizeY = new Uint8Array(cap);

  const terrain = new Uint8Array(size * size);
  const resourceType = new Uint8Array(size * size);
  const resourceAmount = new Float32Array(size * size);
  const occupant = new Int32Array(size * size).fill(-1);
  const visible = new Uint8Array(size * size);
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

  const players = [
    { id: 0, resources: new Float32Array([0, 0, 0, 0]) },
    { id: 1, resources: new Float32Array([1000, 1000, 1000, 1000]) },
    { id: 2, resources: new Float32Array([1000, 1000, 1000, 1000]) },
  ];

  const comp = { capacity: cap, kind, subtype, owner, flags, posX, posY, radius, sizeX, sizeY } as unknown;
  const map = { size, terrain, resourceType, resourceAmount, occupant, visible, explored } as unknown;
  const world = { mapSize: size, em, comp, map, grid, players } as unknown as World;

  return {
    world,
    spawn(k, st, own, x, y): number {
      const i = em.create();
      kind[i] = k;
      subtype[i] = st;
      owner[i] = own;
      posX[i] = x;
      posY[i] = y;
      radius[i] = k === EntityKind.Unit ? 0.3 : 0;
      return i;
    },
    handleFor: (i) => em.handleFor(i),
    explore(tx, ty, player): void {
      if (inBounds(size, tx, ty)) explored[tileIndex(size, tx, ty)] |= 1 << player;
    },
    occupy(tx, ty, handle): void {
      if (inBounds(size, tx, ty)) occupant[tileIndex(size, tx, ty)] = handle;
    },
  };
}

const SIZE = 96;

function mouse(type: string, el: EventTarget, button: number, x: number, y: number, shift = false): void {
  el.dispatchEvent(new MouseEvent(type, { button, clientX: x, clientY: y, shiftKey: shift, bubbles: true }));
}

let controller: InputController;
let canvas: HTMLCanvasElement;
let minimap: HTMLCanvasElement;

beforeEach(() => {
  canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  minimap = document.createElement('canvas');
  minimap.width = 200;
  minimap.height = 200;
  document.body.append(canvas, minimap);
  controller = createInputController(1);
  controller.manualControl = true;
  controller.attach(canvas, minimap);
});

describe('box selection', () => {
  it('a left-drag over own units populates the selection', () => {
    const f = makeWorld(SIZE);
    // Own unit at the camera center -> screen (400,300).
    const idx = f.spawn(EntityKind.Unit, UnitType.Villager, 1, controller.view.camX, controller.view.camY);
    controller.update(f.world, 16); // bind world, prime state

    mouse('mousedown', canvas, 0, 300, 200);
    mouse('mousemove', canvas, 0, 500, 400);
    mouse('mouseup', window, 0, 500, 400);

    expect(controller.view.selection).toEqual([f.handleFor(idx)]);
  });
});

describe('right-click context command', () => {
  it('emits an attack command against an enemy entity under the cursor', () => {
    const f = makeWorld(SIZE);
    const own = f.spawn(EntityKind.Unit, UnitType.Villager, 1, 10, 10);
    const enemy = f.spawn(EntityKind.Unit, UnitType.Militia, 2, controller.view.camX, controller.view.camY);
    f.explore(Math.floor(controller.view.camX), Math.floor(controller.view.camY), 1);
    controller.view.selection = [f.handleFor(own)];
    controller.update(f.world, 16);

    // Right-click at the enemy's screen position (camera center -> 400,300).
    mouse('mousedown', canvas, 2, 400, 300);

    const cmds = controller.drainCommands();
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0];
    expect(cmd.type).toBe('attack');
    if (cmd.type === 'attack') {
      expect(cmd.player).toBe(1);
      expect(cmd.units).toEqual([f.handleFor(own)]);
      expect(cmd.target).toBe(f.handleFor(enemy));
    }
    // Buffer is drained.
    expect(controller.drainCommands()).toEqual([]);
  });

  it('emits a gatherEntity command against a gaia sheep for selected villagers', () => {
    const f = makeWorld(SIZE);
    const vil = f.spawn(EntityKind.Unit, UnitType.Villager, 1, 10, 10);
    const sheep = f.spawn(EntityKind.Unit, UnitType.Sheep, GAIA, controller.view.camX, controller.view.camY);
    f.explore(Math.floor(controller.view.camX), Math.floor(controller.view.camY), 1);
    controller.view.selection = [f.handleFor(vil)];
    controller.update(f.world, 16);

    mouse('mousedown', canvas, 2, 400, 300);

    const cmds = controller.drainCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].type).toBe('gatherEntity');
    if (cmds[0].type === 'gatherEntity') expect(cmds[0].target).toBe(f.handleFor(sheep));
  });
});

describe('auto play mode', () => {
  it('suppresses selection and commands while manualControl is false', () => {
    const f = makeWorld(SIZE);
    const idx = f.spawn(EntityKind.Unit, UnitType.Villager, 1, controller.view.camX, controller.view.camY);
    controller.manualControl = false;
    controller.update(f.world, 16);

    mouse('mousedown', canvas, 0, 300, 200);
    mouse('mousemove', canvas, 0, 500, 400);
    mouse('mouseup', window, 0, 500, 400);

    expect(controller.view.selection).toEqual([]);
    expect(controller.drainCommands()).toEqual([]);
    controller.enqueueCommand({ type: 'stop', player: 1, units: [f.handleFor(idx)] });
    expect(controller.drainCommands()).toEqual([]);
  });
});

describe('build ghost placement', () => {
  it('a click on an invalid (occupied) tile emits no command', () => {
    const f = makeWorld(SIZE);
    const vil = f.spawn(EntityKind.Unit, UnitType.Villager, 1, 5, 5);
    // Occupy the House footprint so canPlaceBuilding returns false.
    f.occupy(5, 5, 12345);
    controller.view.selection = [f.handleFor(vil)];
    controller.view.ghost = { building: 1 /* House */, tileX: 5, tileY: 5, valid: false };
    controller.update(f.world, 16);

    mouse('mousedown', canvas, 0, 400, 300);

    expect(controller.view.ghost).not.toBeNull();
    expect(controller.view.ghost?.valid).toBe(false);
    expect(controller.drainCommands()).toEqual([]);
  });
});
