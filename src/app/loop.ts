// src/app/loop.ts
// Fixed-timestep requestAnimationFrame game loop. The simulation advances at a fixed 20Hz via an
// accumulator; the renderer draws every animation frame at an interpolation alpha. Per catch-up tick,
// human input commands are collected BEFORE AI commands. GameEvents produced across all catch-up ticks
// within a frame are accumulated and flushed to the HUD (so toasts on multi-tick frames are not lost).
// When the match ends, stepping stops but rendering continues.

import type { World } from '../shared/world';
import type { AIPlayer, Renderer, InputController, ViewState } from '../shared/interfaces';
import type { GameEvent } from '../shared/events';
import type { Command } from '../shared/commands';
import { MS_PER_TICK, MAX_TICKS_PER_FRAME, MIN_SIM_SPEED, MAX_SIM_SPEED } from '../shared/constants';
import { MatchStatus } from '../shared/enums';
import { stepWorld } from '../sim/step-default';
import type { Hud } from '../ui/hud';

// Longest wall-clock span folded into the accumulator in one frame. Equals the catch-up cap so a single
// slow frame can never queue more than MAX_TICKS_PER_FRAME ticks (avoids the spiral of death).
const MAX_FRAME_MS = MAX_TICKS_PER_FRAME * MS_PER_TICK;
// HUD + minimap refresh cadence (every Nth animation frame) — DOM/minimap work is throttled.
const UI_REFRESH_EVERY = 6;

export interface GameLoopOptions {
  world: World;
  ais: AIPlayer[];
  /** When autoPlay() is true, local AI commands are injected before opponent AIs (replacing human input). */
  localAI?: AIPlayer;
  autoPlay?: () => boolean;
  /** Simulation speed multiplier in [MIN_SIM_SPEED, MAX_SIM_SPEED]; defaults to 1. */
  simSpeed?: () => number;
  input: InputController;
  renderer: Renderer;
  minimapCtx: CanvasRenderingContext2D;
  hud: Hud;
  /**
   * Optional procedural-audio hook (src/audio). Purely additive: when omitted the loop is unchanged.
   * onCommands sees ONLY the human commands for a tick (called before AI commands are appended);
   * onTick fires once per sim tick right after stepWorld with that tick's events (per-tick latency,
   * not the 6-frame HUD flush). The loop never mutates the arrays it passes in.
   */
  audio?: {
    onTick(evs: readonly GameEvent[], world: World, view: ViewState, ticksThisFrame: number): void;
    onCommands?(cmds: readonly Command[]): void;
  };
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
}

export interface GameLoop {
  start(): void;
  stop(): void;
}

export function createGameLoop(opts: GameLoopOptions): GameLoop {
  const { world, input, renderer, minimapCtx, hud, localAI, autoPlay, simSpeed } = opts;
  // AIs iterated in ascending player order for deterministic command ordering.
  const ais = opts.ais.slice().sort((a, b) => a.player - b.player);
  const clock = opts.now ?? (() => performance.now());
  const schedule = opts.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));

  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let acc = 0;
  let frameCount = 0;
  // Events pending delivery to the HUD, accumulated across frames until the next UI refresh.
  const pendingEvents: GameEvent[] = [];

  const frame = (): void => {
    if (!running) return;
    rafId = schedule(frame);

    const t = clock();
    const dt = t - lastTime;
    lastTime = t;

    if (!isEnded(world)) {
      const speed = clampSimSpeed(simSpeed?.() ?? MIN_SIM_SPEED);
      acc += clampFrameDt(dt, speed);
      const maxTicks = MAX_TICKS_PER_FRAME * speed;
      let ticks = 0;
      while (acc >= MS_PER_TICK && ticks < maxTicks) {
        // Human commands first (or local AI when auto-playing), then each opponent AI in ascending player order.
        const cmds: Command[] = input.drainCommands();
        // Audio hears the human commands ONLY (before any AI commands are appended below).
        opts.audio?.onCommands?.(cmds);
        if (autoPlay?.() && localAI) {
          const localCmds = localAI.think(world);
          for (let i = 0; i < localCmds.length; i++) cmds.push(localCmds[i]);
        }
        for (const ai of ais) {
          const aiCmds = ai.think(world);
          for (let i = 0; i < aiCmds.length; i++) cmds.push(aiCmds[i]);
        }
        const evs = stepWorld(world, cmds);
        // Per-tick audio (ticks is the count of prior ticks this frame, so ticks+1 is this tick's index).
        opts.audio?.onTick(evs, world, input.view, ticks + 1);
        for (let i = 0; i < evs.length; i++) pendingEvents.push(evs[i]);
        acc -= MS_PER_TICK;
        ticks++;
        if (isEnded(world)) break; // stepWorld may have ended the match mid catch-up
      }
    }

    // Camera pan / dead-selection pruning uses real frame dt.
    input.update(world, dt);

    const alpha = acc / MS_PER_TICK; // in [0,1) given the MAX_FRAME_MS clamp == cap*tick
    renderer.render(world, input.view, alpha);

    if (frameCount % UI_REFRESH_EVERY === 0) {
      renderer.renderMinimap(world, input.view, minimapCtx);
      hud.update(world, pendingEvents);
      pendingEvents.length = 0;
    }
    frameCount++;
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      lastTime = clock();
      rafId = schedule(frame);
    },
    stop(): void {
      running = false;
      if (!opts.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
    },
  };
}

function clampSimSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return MIN_SIM_SPEED;
  if (speed < MIN_SIM_SPEED) return MIN_SIM_SPEED;
  if (speed > MAX_SIM_SPEED) return MAX_SIM_SPEED;
  return Math.floor(speed);
}

function clampFrameDt(dt: number, speed: number): number {
  if (dt < 0) return 0;
  const maxMs = MAX_FRAME_MS * speed;
  return dt > maxMs ? maxMs * speed : dt * speed;
}

// Wrapped in a function so control-flow analysis never narrows world.status across stepWorld's mutation.
function isEnded(world: World): boolean {
  return world.status === MatchStatus.Ended;
}
