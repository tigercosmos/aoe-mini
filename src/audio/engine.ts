// src/audio/engine.ts
// createSfxEngine() owns the real AudioContext lifecycle: lazy creation on a user gesture (resume),
// the master voice -> category-bus -> master-gain -> compressor -> destination chain, a fixed voice
// pool with priority stealing + per-category caps, mute/volume persistence, a page-visibility duck,
// and a barely-there ambient bed. Constructs NOTHING at import time and NOTHING until resume(); with
// no AudioContext backend every method is a safe no-op so jsdom + `npm run headless` never touch WebAudio.

import type {
  AudioContextLike, AudioNodeLike, AudioParamLike, Category, EnginePort, GainLike, PlayOpts, SoundId,
} from './types';
import { SOUNDS, buildVoice, type VoiceHandle } from './synth';

const STORAGE_KEY = 'aoe.audio.v1';
const MIN_GAIN = 0.0001;
const MASTER_DEFAULT = 0.8;
const HARD_CAP = 24;

const CATEGORIES: Category[] = ['combat', 'econ', 'ui', 'notify', 'fanfare', 'ambient'];
const CATEGORY_BUS_GAIN: Record<Category, number> = {
  combat: 0.9, econ: 0.5, ui: 0.6, notify: 0.8, fanfare: 1.0, ambient: 0.35,
};
const CATEGORY_CAP: Record<Category, number> = {
  combat: 8, econ: 4, ui: 2, notify: 4, fanfare: 2, ambient: 4,
};

export interface GameAudioEngine extends EnginePort {
  resume(): void;
  setMuted(muted: boolean): void;
  toggleMuted(): boolean;
  getMuted(): boolean;
  dispose(): void;
  /** True once a real AudioContext backend is available (false under jsdom/headless). */
  readonly real: boolean;
}

// The real ctx surface we lean on beyond the pure AudioContextLike used by buildVoice/tests.
interface EngineContext extends AudioContextLike {
  readonly state?: string;
  destination: AudioNodeLike;
  sampleRate?: number;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
  createDynamicsCompressor?(): {
    threshold: AudioParamLike; knee: AudioParamLike; ratio: AudioParamLike;
    attack: AudioParamLike; release: AudioParamLike; connect(d: AudioNodeLike): void;
  };
  createBuffer?(channels: number, length: number, sampleRate: number): { getChannelData(ch: number): Float32Array };
}

export interface SfxEngineOptions {
  /** Test/host hook: supply an AudioContext factory (mirrors setCanvasFactory). Absent = window.AudioContext. */
  contextFactory?: () => EngineContext;
}

interface LiveVoice {
  category: Category;
  priority: number;
  startedAt: number;
  handle: VoiceHandle;
  released: boolean;
}

function wallClock(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function loadPersisted(): { muted: boolean; volume: number } {
  try {
    if (typeof localStorage === 'undefined') return { muted: false, volume: MASTER_DEFAULT };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { muted?: unknown; volume?: unknown };
      return {
        muted: o.muted === true,
        volume: typeof o.volume === 'number' && o.volume >= 0 && o.volume <= 1 ? o.volume : MASTER_DEFAULT,
      };
    }
  } catch {
    // private mode / disabled storage — fall through to defaults.
  }
  return { muted: false, volume: MASTER_DEFAULT };
}

function persist(muted: boolean, volume: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted, volume }));
  } catch {
    // ignore
  }
}

export function createSfxEngine(options: SfxEngineOptions = {}): GameAudioEngine {
  const factory = resolveContextFactory(options.contextFactory);

  // ---- persisted user prefs (available even in the no-op path) ----
  const persisted = loadPersisted();
  let muted = persisted.muted;
  let volume = persisted.volume;

  // ---- no-backend path: same interface, all no-ops (still remembers the mute pref) ----
  if (!factory) {
    return {
      play(): void {},
      now(): number { return wallClock(); },
      resume(): void {},
      setMuted(m: boolean): void { muted = m; persist(muted, volume); },
      toggleMuted(): boolean { muted = !muted; persist(muted, volume); return muted; },
      getMuted(): boolean { return muted; },
      dispose(): void {},
      real: false,
    };
  }

  // ---- real engine state (nodes created lazily in resume) ----
  let ctx: EngineContext | null = null;
  let master: GainLike | null = null;
  const buses: Partial<Record<Category, GainLike>> = {};
  let ambientBus: GainLike | null = null;
  let noiseBuffer: unknown = null;
  let hidden = typeof document !== 'undefined' ? document.hidden === true : false;

  const voices: LiveVoice[] = [];
  const perCat: Record<Category, number> = { combat: 0, econ: 0, ui: 0, notify: 0, fanfare: 0, ambient: 0 };

  // ambient bed handles (for dispose)
  let ambientStarted = false;
  let birdTimer: ReturnType<typeof setTimeout> | null = null;
  const ambientSources: { stop(t?: number): void }[] = [];

  const onVisibility = (): void => {
    hidden = typeof document !== 'undefined' ? document.hidden === true : false;
    applyMasterTarget();
    if (!hidden && !muted) scheduleBird(); // resume chirps when returning to the tab
  };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  function applyMasterTarget(): void {
    if (!ctx || !master) return;
    const target = muted || hidden ? MIN_GAIN : Math.max(MIN_GAIN, volume);
    try {
      master.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
    } catch {
      master.gain.value = target;
    }
  }

  function buildMasterChain(c: EngineContext): void {
    master = c.createGain();
    master.gain.value = muted || hidden ? MIN_GAIN : volume;

    let sink: AudioNodeLike = master;
    if (typeof c.createDynamicsCompressor === 'function') {
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      master.connect(comp);
      comp.connect(c.destination);
      sink = master; // voices connect to buses -> master -> comp -> destination
    } else {
      master.connect(c.destination);
    }
    void sink;

    for (const cat of CATEGORIES) {
      const bus = c.createGain();
      bus.gain.value = CATEGORY_BUS_GAIN[cat];
      bus.connect(master);
      buses[cat] = bus;
    }
    ambientBus = buses.ambient ?? null;
  }

  function makeNoiseBuffer(c: EngineContext): unknown {
    if (typeof c.createBuffer !== 'function') return null;
    const sr = c.sampleRate && c.sampleRate > 0 ? c.sampleRate : 44100;
    try {
      const buf = c.createBuffer(1, sr, sr); // 1 s mono white noise (Math.random legal in src/audio)
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    } catch {
      return null;
    }
  }

  function release(v: LiveVoice): void {
    if (v.released) return;
    v.released = true;
    perCat[v.category] = Math.max(0, perCat[v.category] - 1);
    const idx = voices.indexOf(v);
    if (idx >= 0) voices.splice(idx, 1);
  }

  function stealVoice(v: LiveVoice): void {
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      const g = v.handle.voiceGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(MIN_GAIN, g.value || MIN_GAIN), t);
      g.linearRampToValueAtTime(MIN_GAIN, t + 0.015);
      for (const s of v.handle.sources) {
        try { s.stop(t + 0.02); } catch { /* already stopped */ }
      }
    } catch {
      // best effort
    }
    release(v);
  }

  /** Global lowest-priority, oldest-among-ties live voice (steal candidate). */
  function stealCandidate(): LiveVoice | null {
    let best: LiveVoice | null = null;
    for (const v of voices) {
      if (v.released) continue;
      if (!best || v.priority < best.priority || (v.priority === best.priority && v.startedAt < best.startedAt)) {
        best = v;
      }
    }
    return best;
  }

  function admit(cat: Category, priority: number): boolean {
    if (voices.length < HARD_CAP && perCat[cat] < CATEGORY_CAP[cat]) return true;
    const victim = stealCandidate();
    if (victim && victim.priority < priority) {
      stealVoice(victim);
      return voices.length < HARD_CAP && perCat[cat] < CATEGORY_CAP[cat];
    }
    return false; // equal/lower priority — drop the incoming sound
  }

  function play(id: SoundId, opts?: PlayOpts): void {
    if (!ctx || ctx.state !== 'running' || muted || hidden) return;
    const spec = SOUNDS[id];
    if (!spec) return;
    const cat = spec.category;
    const bus = buses[cat];
    if (!bus) return;
    if (!admit(cat, spec.priority)) return;

    const detuneCents = spec.randomizeDetune ? (Math.random() * 2 - 1) * spec.randomizeDetune : 0;
    let handle: VoiceHandle;
    try {
      handle = buildVoice(ctx, spec, {
        destination: bus,
        noiseBuffer,
        startTime: ctx.currentTime,
        gain: opts?.gain ?? 1,
        pan: opts?.pan,
        detuneCents,
      });
    } catch {
      return; // never let a bad recipe crash the frame
    }

    const voice: LiveVoice = { category: cat, priority: spec.priority, startedAt: wallClock(), handle, released: false };
    voices.push(voice);
    perCat[cat] += 1;

    const main = handle.mainSource;
    if (main) {
      main.onended = () => release(voice);
    } else {
      // No audible source (shouldn't happen) — free the slot immediately.
      release(voice);
    }
  }

  // ---- ambient bed ----

  function startAmbient(): void {
    if (ambientStarted || !ctx || !ambientBus || !noiseBuffer) return;
    ambientStarted = true;
    try {
      const wind = ctx.createBufferSource();
      wind.buffer = noiseBuffer;
      wind.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 450;
      lp.Q.value = 0.6;
      const windGain = ctx.createGain();
      windGain.gain.value = 0.015;
      // Slow LFO sweeps the cutoff 300-600 Hz.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.1;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 150;
      lfo.connect(lfoDepth);
      lfoDepth.connect(lp.frequency);
      wind.connect(lp);
      lp.connect(windGain);
      windGain.connect(ambientBus);
      wind.start();
      lfo.start();
      ambientSources.push(wind, lfo);
    } catch {
      // ignore ambient failures
    }
    scheduleBird();
  }

  function scheduleBird(): void {
    if (birdTimer) return; // already scheduled
    if (typeof setTimeout === 'undefined') return;
    const delay = 4000 + Math.random() * 9000;
    birdTimer = setTimeout(() => {
      birdTimer = null;
      chirp();
      scheduleBird();
    }, delay);
  }

  function chirp(): void {
    if (!ctx || ctx.state !== 'running' || !ambientBus || muted || hidden) return;
    try {
      const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      const out: AudioNodeLike = panner ?? ambientBus;
      if (panner) {
        panner.pan.value = (Math.random() * 2 - 1) * 0.7;
        panner.connect(ambientBus);
      }
      const n = 2 + ((Math.random() * 3) | 0); // 2..4 blips
      const base = 2500 + Math.random() * 1700; // 2500..4200
      const t0 = ctx.currentTime;
      for (let k = 0; k < n; k++) {
        const start = t0 + k * 0.09;
        const f = base + (Math.random() * 2 - 1) * 300;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, start);
        osc.frequency.linearRampToValueAtTime(f * 0.85, start + 0.04); // downward bend
        const g = ctx.createGain();
        g.gain.setValueAtTime(MIN_GAIN, start);
        g.gain.linearRampToValueAtTime(0.03, start + 0.01);
        g.gain.exponentialRampToValueAtTime(MIN_GAIN, start + 0.05);
        osc.connect(g);
        g.connect(out);
        osc.start(start);
        osc.stop(start + 0.08);
      }
    } catch {
      // ignore
    }
  }

  // ---- public methods ----

  function resume(): void {
    try {
      if (!ctx) {
        ctx = factory!();
        noiseBuffer = makeNoiseBuffer(ctx);
        buildMasterChain(ctx);
      }
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
      }
      if (ctx && !muted && !hidden) startAmbient();
    } catch {
      // resume is best-effort; a failure just means silence.
    }
  }

  function setMuted(m: boolean): void {
    muted = m;
    persist(muted, volume);
    applyMasterTarget();
    if (!muted && !hidden) startAmbient();
  }

  function toggleMuted(): boolean {
    setMuted(!muted);
    return muted;
  }

  function dispose(): void {
    if (birdTimer) { clearTimeout(birdTimer); birdTimer = null; }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    for (const v of voices.slice()) {
      for (const s of v.handle.sources) { try { s.stop(); } catch { /* noop */ } }
    }
    voices.length = 0;
    for (const s of ambientSources) { try { s.stop(); } catch { /* noop */ } }
    ambientSources.length = 0;
    if (ctx && typeof ctx.close === 'function') {
      const p = ctx.close();
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    }
    ctx = null;
    master = null;
    ambientBus = null;
    ambientStarted = false;
  }

  return {
    play,
    now(): number { return wallClock(); },
    resume,
    setMuted,
    toggleMuted,
    getMuted(): boolean { return muted; },
    dispose,
    real: true,
  };
}

function resolveContextFactory(injected?: () => EngineContext): (() => EngineContext) | null {
  if (injected) return injected;
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const Ctor = (w.AudioContext ?? w.webkitAudioContext) as (new () => EngineContext) | undefined;
  if (!Ctor) return null;
  return () => new Ctor();
}
