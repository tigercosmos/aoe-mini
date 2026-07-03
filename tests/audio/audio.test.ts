// tests/audio/audio.test.ts
// Standalone tests for the procedural SFX layer (src/audio). No real AudioContext is used:
// - the dispatcher is driven through a recording EnginePort fake + hand-built worlds (mirrors the
//   render tests' hand-built World approach), asserting the GameEvent -> SoundId mapping, fog gating,
//   the retrigger throttle, and autoplay muting of acks;
// - the synth recipe table + buildVoice() are checked against a fake AudioContextLike so the node-graph
//   builder is exercised headlessly.

import { describe, it, expect } from 'vitest';
import { EntityKind, UnitType, BuildingType, ProjectileType, OrderType, Age } from '../../src/shared/enums';
import { makeHandle } from '../../src/shared/world';
import type { World } from '../../src/shared/world';
import type { ViewState } from '../../src/shared/interfaces';
import type { GameEvent } from '../../src/shared/events';
import type { Command } from '../../src/shared/commands';
import { createDispatcher } from '../../src/audio/dispatcher';
import { SOUNDS, buildVoice } from '../../src/audio/synth';
import { SOUND_IDS, type SoundId } from '../../src/audio/types';
import type {
  AudioContextLike, AudioParamLike, GainLike, OscillatorLike, BiquadLike, BufferSourceLike, StereoPannerLike,
} from '../../src/audio/types';

// ---------------------------------------------------------------------------
// Recording EnginePort fake with a controllable clock.
// ---------------------------------------------------------------------------
function makeEngine() {
  const calls: Array<{ id: SoundId; gain: number; pan: number }> = [];
  let clock = 0;
  return {
    port: {
      play(id: SoundId, opts?: { gain?: number; pan?: number }): void {
        calls.push({ id, gain: opts?.gain ?? 1, pan: opts?.pan ?? 0 });
      },
      now(): number { return clock; },
    },
    calls,
    ids(): SoundId[] { return calls.map((c) => c.id); },
    setNow(v: number): void { clock = v; },
    clear(): void { calls.length = 0; },
  };
}

// ---------------------------------------------------------------------------
// Minimal hand-built World with only the fields the dispatcher reads.
// ---------------------------------------------------------------------------
function makeWorld(size = 8, capacity = 16): World {
  const n = size * size;
  const generation = new Uint16Array(capacity);
  const alive = new Uint8Array(capacity);
  const comp = {
    capacity,
    kind: new Uint8Array(capacity),
    subtype: new Uint16Array(capacity),
    owner: new Uint8Array(capacity),
    posX: new Float32Array(capacity),
    posY: new Float32Array(capacity),
    attackRange: new Float32Array(capacity),
    attackCooldown: new Float32Array(capacity),
    orderType: new Uint8Array(capacity),
    orderTile: new Int32Array(capacity).fill(-1),
  };
  const em = {
    capacity,
    alive,
    generation,
    handleFor(i: number): number { return makeHandle(i, generation[i]); },
    isAlive(i: number): boolean { return alive[i] === 1; },
  };
  const map = {
    size,
    visible: new Uint8Array(n),
    resourceType: new Uint8Array(n),
  };
  return { tick: 0, mapSize: size, em, comp, map } as unknown as World;
}

function makeView(localPlayer = 1, overrides: Partial<ViewState> = {}): ViewState {
  return {
    camX: 4, camY: 4, zoom: 1, viewportW: 800, viewportH: 600,
    localPlayer, selection: [], ghost: null, ...overrides,
  };
}

function reveal(world: World, tx: number, ty: number, player: number): void {
  world.map.visible[ty * world.mapSize + tx] |= (1 << player);
}

function addUnit(world: World, i: number, subtype: number, owner: number, x: number, y: number): number {
  const c = world.comp;
  world.em.alive[i] = 1;
  c.kind[i] = EntityKind.Unit;
  c.subtype[i] = subtype;
  c.owner[i] = owner;
  c.posX[i] = x; c.posY[i] = y;
  c.orderType[i] = OrderType.Idle;
  return makeHandle(i, world.em.generation[i]);
}

// ---------------------------------------------------------------------------

describe('audio dispatcher — event mapping', () => {
  it('plays villagerPop for a spawned local villager on a visible tile', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    reveal(world, 4, 4, 1);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    const ev: GameEvent = { type: 'spawned', entity: 0, owner: 1, kind: EntityKind.Unit, subtype: UnitType.Villager, x: 4, y: 4 };
    d.onTick([ev], world, view, 1);
    expect(eng.ids()).toContain('villagerPop');
  });

  it('plays militaryReady for a spawned local soldier, and nothing for enemy spawns', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    reveal(world, 4, 4, 1);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    d.onTick([{ type: 'spawned', entity: 0, owner: 1, kind: EntityKind.Unit, subtype: UnitType.Knight, x: 4, y: 4 }], world, view, 1);
    expect(eng.ids()).toContain('militaryReady');
    eng.clear();
    d.onTick([{ type: 'spawned', entity: 0, owner: 2, kind: EntityKind.Unit, subtype: UnitType.Knight, x: 4, y: 4 }], world, view, 1);
    expect(eng.calls).toHaveLength(0);
  });

  it('fog-gates positional sounds: no sound on a tile the local player cannot see', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    // tile (4,4) deliberately NOT revealed to player 1
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    d.onTick([{ type: 'spawned', entity: 0, owner: 1, kind: EntityKind.Unit, subtype: UnitType.Villager, x: 4, y: 4 }], world, view, 1);
    expect(eng.calls).toHaveLength(0);
  });

  it('maps projectileFired to arrowFire / axeThrow via the shooter position', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    reveal(world, 4, 4, 1);
    const from = addUnit(world, 0, UnitType.Archer, 1, 4, 4);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    d.onTick([{ type: 'projectileFired', from, to: from, projectile: ProjectileType.Arrow }], world, view, 1);
    expect(eng.ids()).toContain('arrowFire');
    eng.clear();
    eng.setNow(10_000); // clear any throttle window
    d.onTick([{ type: 'projectileFired', from, to: from, projectile: ProjectileType.Axe }], world, view, 1);
    expect(eng.ids()).toContain('axeThrow');
  });

  it('distinguishes local vs enemy age-up fanfares', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    d.onTick([{ type: 'ageAdvanced', player: 1, age: Age.Feudal }], world, view, 1);
    expect(eng.ids()).toContain('ageFeudal');
    eng.clear();
    d.onTick([{ type: 'ageAdvanced', player: 2, age: Age.Castle }], world, view, 1);
    expect(eng.ids()).toContain('enemyAgeCastle');
  });

  it('maps deaths: building collapse vs unit death', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    reveal(world, 4, 4, 1);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    d.onTick([{ type: 'died', entity: 0, owner: 2, kind: EntityKind.Building, subtype: BuildingType.House, x: 4, y: 4, killer: 1 }], world, view, 1);
    expect(eng.ids()).toContain('buildingCollapse');
    eng.clear();
    eng.setNow(10_000);
    d.onTick([{ type: 'died', entity: 0, owner: 2, kind: EntityKind.Unit, subtype: UnitType.Militia, x: 4, y: 4, killer: 1 }], world, view, 1);
    expect(eng.ids()).toContain('unitDeath');
  });

  it('plays matchWon / matchLost from the local perspective (always, ungated)', () => {
    const world = makeWorld();
    const view = makeView(1);
    const won = makeEngine();
    createDispatcher(won.port, { isAutoPlay: () => false }).onTick([{ type: 'matchEnded', winner: 1 }], world, view, 1);
    expect(won.ids()).toContain('matchWon');
    const lost = makeEngine();
    createDispatcher(lost.port, { isAutoPlay: () => false }).onTick([{ type: 'matchEnded', winner: 2 }], world, view, 1);
    expect(lost.ids()).toContain('matchLost');
  });
});

describe('audio dispatcher — throttle + acks', () => {
  it('suppresses a low-priority retrigger inside its window but replays after it', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    reveal(world, 4, 4, 1);
    const from = addUnit(world, 0, UnitType.Archer, 1, 4, 4);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    const fire: GameEvent = { type: 'projectileFired', from, to: from, projectile: ProjectileType.Arrow };
    const window = SOUNDS.arrowFire.retriggerMs;
    expect(SOUNDS.arrowFire.priority).toBeLessThan(3); // precondition: it IS gated

    eng.setNow(0);
    d.onTick([fire], world, view, 1);
    eng.setNow(Math.max(1, window - 1));
    d.onTick([fire], world, view, 1);
    expect(eng.ids().filter((x) => x === 'arrowFire')).toHaveLength(1); // second suppressed

    eng.setNow(window + 5);
    d.onTick([fire], world, view, 1);
    expect(eng.ids().filter((x) => x === 'arrowFire')).toHaveLength(2); // window elapsed -> replays
  });

  it('never throttles priority-3 stings/fanfares', () => {
    const eng = makeEngine();
    const world = makeWorld();
    const view = makeView(1);
    const d = createDispatcher(eng.port, { isAutoPlay: () => false });
    const ev: GameEvent = { type: 'matchEnded', winner: 1 };
    eng.setNow(0);
    d.onTick([ev], world, view, 1);
    eng.setNow(1);
    d.onTick([ev], world, view, 1);
    expect(eng.ids().filter((x) => x === 'matchWon')).toHaveLength(2);
  });

  it('emits a command ack in manual mode but stays silent under autoplay', () => {
    const world = makeWorld();
    const view = makeView(1);
    const manual = makeEngine();
    const dm = createDispatcher(manual.port, { isAutoPlay: () => false });
    dm.onCommands([{ type: 'move', player: 1, units: [0], x: 3, y: 3 } as Command]);
    expect(manual.ids()).toContain('ackMove');

    const auto = makeEngine();
    const da = createDispatcher(auto.port, { isAutoPlay: () => true });
    da.onCommands([{ type: 'move', player: 1, units: [0], x: 3, y: 3 } as Command]);
    expect(auto.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Synth recipe table + buildVoice() against a fake AudioContext.
// ---------------------------------------------------------------------------
function makeParam(): AudioParamLike {
  return {
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {},
  };
}
function makeAudioCtx(counts: Record<string, number>): AudioContextLike {
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const gain = (): GainLike => (bump('gain'), { gain: makeParam(), connect() {}, disconnect() {} });
  const osc = (): OscillatorLike => (bump('osc'), {
    type: 'sine', frequency: makeParam(), detune: makeParam(),
    connect() {}, disconnect() {}, start() {}, stop() {}, onended: null,
  });
  const biquad = (): BiquadLike => (bump('biquad'), {
    type: 'lowpass', frequency: makeParam(), Q: makeParam(), connect() {}, disconnect() {},
  });
  const buf = (): BufferSourceLike => (bump('buffer'), {
    buffer: null, loop: false, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null,
  });
  const panner = (): StereoPannerLike => (bump('panner'), { pan: makeParam(), connect() {}, disconnect() {} });
  return {
    currentTime: 0,
    createGain: gain, createOscillator: osc, createBiquadFilter: biquad,
    createBufferSource: buf, createStereoPanner: panner,
  };
}

describe('audio synth recipe table', () => {
  it('defines a spec for every SoundId with sane, non-clipping layers', () => {
    for (const id of SOUND_IDS) {
      const spec = SOUNDS[id];
      expect(spec, `missing spec for ${id}`).toBeTruthy();
      expect(spec.layers.length, `no layers for ${id}`).toBeGreaterThan(0);
      expect(typeof spec.priority).toBe('number');
      expect(spec.retriggerMs).toBeGreaterThanOrEqual(0);
      for (const layer of spec.layers) {
        // Pre-master peak contract: every layer <= 0.35 (the engine bus/compressor does the rest).
        expect(layer.peak, `${id} layer peak too hot`).toBeLessThanOrEqual(0.35 + 1e-9);
        expect(layer.peak).toBeGreaterThan(0);
      }
    }
  });

  it('buildVoice() constructs a node graph for a representative sound without throwing', () => {
    const counts: Record<string, number> = {};
    const ctx = makeAudioCtx(counts);
    const handle = buildVoice(ctx, SOUNDS.meleeClank, {
      destination: { connect() {}, disconnect() {} }, noiseBuffer: {}, startTime: 0, gain: 1, pan: 0.3,
    });
    expect(handle.sources.length).toBeGreaterThan(0);
    expect(handle.endTime).toBeGreaterThan(0);
    expect((counts.osc ?? 0) + (counts.buffer ?? 0)).toBeGreaterThan(0); // at least one audible source
    expect(counts.panner).toBeGreaterThan(0); // non-centered + pan given -> panner inserted
  });

  it('buildVoice() omits the panner for a centered spec', () => {
    const counts: Record<string, number> = {};
    const ctx = makeAudioCtx(counts);
    // matchWon is a centered priority-3 sting.
    expect(SOUNDS.matchWon.centered).toBe(true);
    buildVoice(ctx, SOUNDS.matchWon, {
      destination: { connect() {}, disconnect() {} }, noiseBuffer: {}, startTime: 0, gain: 1, pan: 0.5,
    });
    expect(counts.panner ?? 0).toBe(0);
  });
});
