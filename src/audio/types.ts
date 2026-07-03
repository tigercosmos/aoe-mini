// src/audio/types.ts
// Data types for the procedural Web Audio SFX system. No WebAudio objects are constructed here — this
// module is pure declarations shared by synth.ts (recipe table + voice builder), engine.ts (real
// AudioContext lifecycle) and dispatcher.ts (GameEvent -> engine.play mapping). Everything is designed
// so the dispatcher can be unit-tested against a recording fake that only implements EnginePort, and
// buildVoice() can be tested against a fake AudioContext that implements AudioContextLike.

// ---------------------------------------------------------------------------
// Sound identifiers. A const tuple gives us both a strong SoundId union and a runtime-iterable list.
// ---------------------------------------------------------------------------

export const SOUND_IDS = [
  // combat
  'meleeClank', 'arrowFire', 'axeThrow', 'projImpactArrow', 'projImpactAxe',
  'unitDeath', 'buildingCollapse',
  // econ / world-scan loops
  'sheepBaa', 'woodChop', 'mineTink', 'buildTap', 'forageSwish', 'resourceDepleted',
  // notify
  'hornAlert', 'villagerPop', 'militaryReady', 'buildPlaced', 'constructionDone',
  'researchDing', 'playerDefeated',
  // fanfare / stings (priority 3 — never throttled away)
  'ageFeudal', 'ageCastle', 'ageImperial',
  'enemyAgeFeudal', 'enemyAgeCastle', 'enemyAgeImperial',
  'matchWon', 'matchLost',
  // ui + acks
  'reject', 'uiClick', 'selVillager', 'selMilitary',
  'ackMove', 'ackAttack', 'ackGather', 'ackBuild', 'ackTrain',
] as const;

export type SoundId = (typeof SOUND_IDS)[number];

export type Category = 'combat' | 'econ' | 'ui' | 'notify' | 'fanfare' | 'ambient';

// ---------------------------------------------------------------------------
// Declarative synth recipe. A SoundSpec is a bundle of layers plus routing metadata. Every peak gain
// is pre-master and MUST stay <= 0.35 (the engine's category/master/compressor chain does the rest).
// ---------------------------------------------------------------------------

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface FilterSpec {
  kind: 'lowpass' | 'highpass' | 'bandpass';
  freq: number;
  /** Linear sweep target over the layer's decay window (or `glide` for osc layers). */
  freqEnd?: number;
  q?: number;
}

export interface OscLayer {
  type: 'osc';
  wave: Wave;
  /** Base frequency (Hz). Optional when `freqPath` is present, which overrides it. */
  freq?: number;
  /** Linear glide target. */
  freqEnd?: number;
  /** Glide duration in seconds (defaults to attack+decay). */
  glide?: number;
  /** Multi-segment pitch path as [tSeconds, freq] points; overrides freq/freqEnd/glide when present. */
  freqPath?: Array<[number, number]>;
  detuneCents?: number;
  vibratoHz?: number;
  vibratoDepth?: number; // Hz peak deviation
  peak: number;
  attack: number;
  decay: number;
  delay?: number;        // start offset from voice t0 (seconds)
  filter?: FilterSpec;
}

export interface NoiseLayer {
  type: 'noise';
  peak: number;
  attack: number;
  decay: number;
  delay?: number;
  filter?: FilterSpec;
}

export type Layer = OscLayer | NoiseLayer;

export interface SoundSpec {
  category: Category;
  /** 0 ambient, 1 econ/combat, 2 notify/ui, 3 fanfare/stings. Steal order + catch-up protection. */
  priority: number;
  /** Minimum wall-clock gap (ms) between retriggers of this id (scaled up during catch-up frames). */
  retriggerMs: number;
  layers: Layer[];
  /** When true the sound ignores pan (centered) — fanfares, tolls, the under-attack horn. */
  centered?: boolean;
  /** Random +/- detune (cents) applied to every osc layer at play time (engine rolls it). */
  randomizeDetune?: number;
}

// ---------------------------------------------------------------------------
// EnginePort — the surface the dispatcher depends on (tests inject a recording fake).
// ---------------------------------------------------------------------------

export interface PlayOpts {
  gain?: number; // linear multiplier applied to the whole voice (dispatch-time)
  pan?: number;  // -1..1 stereo pan (ignored for centered specs / when panner unavailable)
}

export interface EnginePort {
  play(id: SoundId, opts?: PlayOpts): void;
  /** Wall-clock milliseconds used only for retrigger throttling (NOT the AudioContext clock). */
  now(): number;
}

// ---------------------------------------------------------------------------
// Minimal structural WebAudio interfaces so synth.ts/engine.ts are testable with fakes and never
// import the DOM lib's concrete types (which jsdom lacks).
// ---------------------------------------------------------------------------

export interface AudioParamLike {
  value: number;
  setValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime(v: number, t: number): void;
  exponentialRampToValueAtTime(v: number, t: number): void;
  setTargetAtTime(v: number, t: number, timeConstant: number): void;
  cancelScheduledValues(t: number): void;
}

export interface AudioNodeLike {
  connect(dest: AudioNodeLike | AudioParamLike): AudioNodeLike | void;
  disconnect?(): void;
}

export interface ScheduledSourceLike extends AudioNodeLike {
  start(t?: number): void;
  stop(t?: number): void;
  onended: (() => void) | null;
}

export interface OscillatorLike extends ScheduledSourceLike {
  type: string;
  frequency: AudioParamLike;
  detune: AudioParamLike;
}

export interface BufferSourceLike extends ScheduledSourceLike {
  buffer: unknown;
  loop: boolean;
}

export interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface BiquadLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

export interface StereoPannerLike extends AudioNodeLike {
  pan: AudioParamLike;
}

export interface AudioContextLike {
  currentTime: number;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  createBiquadFilter(): BiquadLike;
  createBufferSource(): BufferSourceLike;
  createStereoPanner?(): StereoPannerLike;
}
