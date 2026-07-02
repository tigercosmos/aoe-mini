/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { World } from '../../src/shared/world';
import type { AIPlayer, InputController, Renderer } from '../../src/shared/interfaces';
import type { Command } from '../../src/shared/commands';
import type { GameEvent } from '../../src/shared/events';
import { MatchStatus } from '../../src/shared/enums';
import { MAX_TICKS_PER_FRAME } from '../../src/shared/constants';

// stepWorld lives in T4's src/sim/step-default.ts (not present at unit time); mock it so we can spy on
// call count, per-tick command ordering, and drive the accumulator. Runs green at the integration pass.
const { stepSpy } = vi.hoisted(() => ({ stepSpy: vi.fn() }));
vi.mock('../../src/sim/step-default', () => ({ stepWorld: stepSpy }));

import { createGameLoop } from '../../src/app/loop';

interface Harness {
  world: World & { status: number; tick: number };
  renderer: Renderer;
  hud: { root: HTMLElement; update: ReturnType<typeof vi.fn> };
  renderAlphas: number[];
  commandLog: Command[][];
  setTime(v: number): void;
  now(): number;
  fireFrame(): void;
  start(): void;
  stop(): void;
}

function makeHarness(
  ais: AIPlayer[],
  humanQueue: Command[] = [],
  localAI?: AIPlayer,
  autoPlay: () => boolean = () => false,
  simSpeed: () => number = () => 1,
): Harness {
  const world = { status: MatchStatus.Running, tick: 0 } as unknown as World & { status: number; tick: number };
  const renderAlphas: number[] = [];
  const commandLog: Command[][] = [];

  stepSpy.mockImplementation((_w: World, commands: Command[]): GameEvent[] => {
    world.tick++;
    commandLog.push(commands);
    return [];
  });

  const input = {
    view: {
      camX: 0,
      camY: 0,
      zoom: 1,
      viewportW: 800,
      viewportH: 600,
      localPlayer: 1,
      selection: [],
      ghost: null,
    },
    attach: vi.fn(),
    detach: vi.fn(),
    update: vi.fn(),
    drainCommands: vi.fn(() => humanQueue.splice(0)),
  } as unknown as InputController;

  const renderer = {
    init: vi.fn(),
    resize: vi.fn(),
    render: vi.fn((_w: World, _v: unknown, alpha: number) => {
      renderAlphas.push(alpha);
    }),
    renderMinimap: vi.fn(),
    dispose: vi.fn(),
  } as unknown as Renderer;

  const hud = { root: document.createElement('div'), update: vi.fn() };
  const minimapCtx = {} as unknown as CanvasRenderingContext2D;

  let t = 0;
  let rafCb: ((n: number) => void) | null = null;
  const now = (): number => t;
  const raf = (cb: (n: number) => void): number => {
    rafCb = cb;
    return 1;
  };

  const loop = createGameLoop({
    world,
    ais,
    localAI,
    autoPlay,
    simSpeed,
    input,
    renderer,
    minimapCtx,
    hud: hud as never,
    now,
    raf,
  });

  return {
    world,
    renderer,
    hud,
    renderAlphas,
    commandLog,
    setTime: (v) => {
      t = v;
    },
    now,
    fireFrame: () => {
      if (rafCb) rafCb(0);
    },
    start: loop.start,
    stop: loop.stop,
  };
}

describe('createGameLoop fixed-timestep', () => {
  let h: Harness;

  beforeEach(() => {
    stepSpy.mockReset();
    const ai: AIPlayer = { player: 1, think: vi.fn(() => [] as Command[]) };
    h = makeHarness([ai]);
  });

  it('steps 1/2/0 times for 50/100/34ms frames (accumulator + carry)', () => {
    h.setTime(1000);
    h.start();

    h.setTime(1050);
    h.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(1);

    h.setTime(1150);
    h.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(3);

    h.setTime(1184);
    h.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(3); // 34ms < one tick -> carried over

    h.stop();
  });

  it('honors MAX_TICKS_PER_FRAME on a very long frame', () => {
    h.setTime(0);
    h.start();
    h.setTime(1000); // clamps to the cap window
    h.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(MAX_TICKS_PER_FRAME);
    h.stop();
  });

  it('steps more ticks at higher sim speed for the same wall-clock frame', () => {
    stepSpy.mockReset();
    const ai: AIPlayer = { player: 2, think: vi.fn(() => [] as Command[]) };
    const at1x = makeHarness([ai], [], undefined, () => false, () => 1);
    at1x.setTime(0);
    at1x.start();
    at1x.setTime(250); // 250ms -> 5 ticks at 1x
    at1x.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(5);
    at1x.stop();

    stepSpy.mockReset();
    const at5x = makeHarness([ai], [], undefined, () => false, () => 5);
    at5x.setTime(0);
    at5x.start();
    at5x.setTime(250); // 250ms -> 25 ticks worth, capped at 5 * MAX_TICKS_PER_FRAME
    at5x.fireFrame();
    expect(stepSpy).toHaveBeenCalledTimes(MAX_TICKS_PER_FRAME * 5);
    at5x.stop();
  });

  it('passes an interpolation alpha in [0,1) to renderer.render', () => {
    h.setTime(0);
    h.start();
    for (const dt of [50, 100, 34, 1000, 25]) {
      h.setTime(h.now() + dt);
      h.fireFrame();
    }
    expect(h.renderAlphas.length).toBeGreaterThan(0);
    for (const a of h.renderAlphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
    h.stop();
  });

  it('stops stepping once the match has ended but keeps rendering', () => {
    h.setTime(0);
    h.start();
    h.setTime(50);
    h.fireFrame();
    const stepsBefore = stepSpy.mock.calls.length;

    h.world.status = MatchStatus.Ended;
    const renderFn = h.renderer.render as ReturnType<typeof vi.fn>;
    const rendersBefore = renderFn.mock.calls.length;
    h.setTime(1000);
    h.fireFrame();

    expect(stepSpy.mock.calls.length).toBe(stepsBefore); // no additional steps
    expect(renderFn.mock.calls.length).toBe(rendersBefore + 1); // render still runs
    h.stop();
  });
});

describe('createGameLoop command ordering', () => {
  it('places human commands before AI commands, AIs ascending by player', () => {
    stepSpy.mockReset();
    const humanCmd: Command = { type: 'stop', player: 1, units: [] };
    const ai2: AIPlayer = { player: 2, think: vi.fn(() => [{ type: 'move', player: 2, units: [], x: 1, y: 1 }] as Command[]) };
    const ai3: AIPlayer = { player: 3, think: vi.fn(() => [{ type: 'move', player: 3, units: [], x: 2, y: 2 }] as Command[]) };
    // AIs provided out of order to prove the loop sorts ascending.
    const h = makeHarness([ai3, ai2], [humanCmd]);

    h.setTime(0);
    h.start();
    h.setTime(50); // exactly one tick
    h.fireFrame();

    expect(h.commandLog).toHaveLength(1);
    const tickCmds = h.commandLog[0];
    expect(tickCmds[0]).toEqual(humanCmd); // human first
    expect(tickCmds[1].player).toBe(2); // then ascending AIs
    expect(tickCmds[2].player).toBe(3);
    h.stop();
  });

  it('injects local AI commands before opponent AIs when auto-playing', () => {
    stepSpy.mockReset();
    const localCmd: Command = { type: 'stop', player: 1, units: [] };
    const localAI: AIPlayer = { player: 1, think: vi.fn(() => [localCmd]) };
    const ai2: AIPlayer = { player: 2, think: vi.fn(() => [{ type: 'move', player: 2, units: [], x: 1, y: 1 }] as Command[]) };
    const h = makeHarness([ai2], [], localAI, () => true);

    h.setTime(0);
    h.start();
    h.setTime(50);
    h.fireFrame();

    expect(h.commandLog).toHaveLength(1);
    const tickCmds = h.commandLog[0];
    expect(tickCmds[0]).toEqual(localCmd);
    expect(tickCmds[1].player).toBe(2);
    h.stop();
  });
});
