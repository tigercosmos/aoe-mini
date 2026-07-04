// src/audio/synth.ts
// The declarative SOUNDS recipe table plus buildVoice(), which turns a SoundSpec into a live node
// graph over an injected AudioContextLike. buildVoice is PURE over its ctx argument (mirrors the
// setCanvasFactory test pattern in the renderer): it constructs nodes, wires envelopes and returns a
// VoiceHandle, but owns no lifecycle. All frequencies/gains are baked constants — the ONLY runtime
// randomness is an optional detune the engine rolls (legal here: src/audio is outside the sim scan).

import type {
  AudioContextLike, AudioNodeLike, BiquadLike, GainLike, Layer, OscLayer, NoiseLayer,
  ScheduledSourceLike, SoundId, SoundSpec,
} from './types';

const MIN_GAIN = 0.0001; // exponential ramps may never touch 0

// ---------------------------------------------------------------------------
// Envelope + layer helpers.
// ---------------------------------------------------------------------------

/** ADSR-ish gain: 0.0001 -> peak (linear, `attack`) -> 0.0001 (exponential, `decay`). */
function envelope(gain: GainLike, t0: number, peak: number, attack: number, decay: number): void {
  const p = Math.max(MIN_GAIN, peak);
  const g = gain.gain;
  g.setValueAtTime(MIN_GAIN, t0);
  g.linearRampToValueAtTime(p, t0 + Math.max(0.001, attack));
  g.exponentialRampToValueAtTime(MIN_GAIN, t0 + Math.max(0.002, attack + decay));
}

function applyFilter(ctx: AudioContextLike, layer: Layer, t0: number, dur: number): BiquadLike | null {
  const f = layer.filter;
  if (!f) return null;
  const node = ctx.createBiquadFilter();
  node.type = f.kind;
  node.frequency.setValueAtTime(Math.max(20, f.freq), t0);
  if (f.freqEnd !== undefined) {
    node.frequency.linearRampToValueAtTime(Math.max(20, f.freqEnd), t0 + Math.max(0.001, dur));
  }
  if (f.q !== undefined) node.Q.value = f.q;
  return node;
}

function buildOsc(
  ctx: AudioContextLike, layer: OscLayer, t0: number, voiceGain: GainLike,
  detuneJitter: number, sources: ScheduledSourceLike[],
): number {
  const start = t0 + (layer.delay ?? 0);
  const dur = Math.max(0.002, layer.attack + layer.decay);
  const osc = ctx.createOscillator();
  osc.type = layer.wave;
  osc.detune.value = (layer.detuneCents ?? 0) + detuneJitter;

  if (layer.freqPath && layer.freqPath.length > 0) {
    const [firstT, firstF] = layer.freqPath[0];
    osc.frequency.setValueAtTime(Math.max(20, firstF), start + firstT);
    for (let k = 1; k < layer.freqPath.length; k++) {
      const [pt, pf] = layer.freqPath[k];
      osc.frequency.linearRampToValueAtTime(Math.max(20, pf), start + pt);
    }
  } else {
    osc.frequency.setValueAtTime(Math.max(20, layer.freq ?? 440), start);
    if (layer.freqEnd !== undefined) {
      osc.frequency.linearRampToValueAtTime(Math.max(20, layer.freqEnd), start + (layer.glide ?? dur));
    }
  }

  const env = ctx.createGain();
  envelope(env, start, layer.peak, layer.attack, layer.decay);
  const filter = applyFilter(ctx, layer, start, dur);
  if (filter) {
    osc.connect(filter);
    filter.connect(env);
  } else {
    osc.connect(env);
  }
  env.connect(voiceGain);

  // Vibrato LFO -> frequency param.
  if (layer.vibratoHz && layer.vibratoDepth) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = layer.vibratoHz;
    const depth = ctx.createGain();
    depth.gain.value = layer.vibratoDepth;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(start);
    lfo.stop(start + dur + 0.05);
    sources.push(lfo);
  }

  osc.start(start);
  const end = start + dur + 0.05;
  osc.stop(end);
  sources.push(osc);
  return end;
}

function buildNoise(
  ctx: AudioContextLike, layer: NoiseLayer, t0: number, voiceGain: GainLike,
  noiseBuffer: unknown, sources: ScheduledSourceLike[],
): number {
  const start = t0 + (layer.delay ?? 0);
  const dur = Math.max(0.002, layer.attack + layer.decay);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;

  const env = ctx.createGain();
  envelope(env, start, layer.peak, layer.attack, layer.decay);
  const filter = applyFilter(ctx, layer, start, dur);
  if (filter) {
    src.connect(filter);
    filter.connect(env);
  } else {
    src.connect(env);
  }
  env.connect(voiceGain);

  src.start(start);
  const end = start + dur + 0.05;
  src.stop(end);
  sources.push(src);
  return end;
}

// ---------------------------------------------------------------------------
// buildVoice — spec -> node graph.
// ---------------------------------------------------------------------------

export interface BuildVoiceOpts {
  destination: AudioNodeLike;
  noiseBuffer: unknown;
  startTime: number;
  gain?: number;
  pan?: number;
  /** Random detune (cents) applied to every osc layer; engine passes a rolled value for spec.randomizeDetune. */
  detuneCents?: number;
}

export interface VoiceHandle {
  sources: ScheduledSourceLike[];
  voiceGain: GainLike;
  mainSource: ScheduledSourceLike | null;
  endTime: number;
}

/** Build a live voice for `spec`. Connects into opts.destination (a per-category bus). Returns handles
 *  so the engine can attach an onended release and hard-stop the voice when it needs to steal it. */
export function buildVoice(ctx: AudioContextLike, spec: SoundSpec, opts: BuildVoiceOpts): VoiceHandle {
  const t0 = opts.startTime;
  const sources: ScheduledSourceLike[] = [];

  const voiceGain = ctx.createGain();
  voiceGain.gain.value = clampGain(opts.gain ?? 1);

  // Optional per-voice panner (skipped when the backend lacks createStereoPanner).
  let tail: AudioNodeLike = voiceGain;
  if (!spec.centered && opts.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = clampPan(opts.pan);
    voiceGain.connect(panner);
    tail = panner;
  }
  tail.connect(opts.destination);

  const detuneJitter = spec.randomizeDetune ? opts.detuneCents ?? 0 : 0;

  let endTime = t0;
  let mainEnd = -1;
  let mainSource: ScheduledSourceLike | null = null;
  for (const layer of spec.layers) {
    const before = sources.length;
    const end = layer.type === 'osc'
      ? buildOsc(ctx, layer, t0, voiceGain, detuneJitter, sources)
      : buildNoise(ctx, layer, t0, voiceGain, opts.noiseBuffer, sources);
    if (end > endTime) endTime = end;
    // The primary (audible) source for this layer is the one appended last that is not a vibrato LFO.
    const primary = sources[sources.length - 1];
    if (primary && end > mainEnd && sources.length > before) {
      mainEnd = end;
      mainSource = primary;
    }
  }

  return { sources, voiceGain, mainSource, endTime };
}

function clampGain(g: number): number {
  if (!Number.isFinite(g) || g <= 0) return MIN_GAIN;
  return g > 4 ? 4 : g;
}
function clampPan(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return p < -0.85 ? -0.85 : p > 0.85 ? 0.85 : p;
}

// ---------------------------------------------------------------------------
// Age fanfare factory (parameterized by chord root + lowpass ceiling).
// ---------------------------------------------------------------------------

function ageFanfare(root: number, lowpassTop: number): SoundSpec {
  const third = root * 1.25;   // major third
  const fifth = root * 1.5;    // perfect fifth
  const octave = root * 2;
  const swellA = 1.0;          // long attack for the 0 -> 0.5 -> 0 swell
  const swellD = 1.0;
  const detunes = [-6, 6, -6, 6, 0];
  const roots = [root, root, third, fifth, octave];
  const layers: Layer[] = [];
  for (let v = 0; v < 5; v++) {
    layers.push({
      type: 'osc', wave: 'sawtooth', freq: roots[v], detuneCents: detunes[v],
      peak: 0.1, attack: swellA, decay: swellD,
      filter: { kind: 'lowpass', freq: 400, freqEnd: lowpassTop, q: 0.9 },
    });
  }
  // researchDing bell an octave up, landing at the 1.0 s mark.
  for (const [bf, bp] of [[1760, 0.05], [3520, 0.035], [5274, 0.02]] as const) {
    layers.push({ type: 'osc', wave: 'sine', freq: bf, peak: bp, attack: 0.005, decay: 0.7, delay: 1.0 });
  }
  return { category: 'fanfare', priority: 3, retriggerMs: 0, centered: true, layers };
}

// ---------------------------------------------------------------------------
// SOUNDS — the recipe table. One entry per SoundId (exhaustive; TS enforces via Record<SoundId,...>).
// ---------------------------------------------------------------------------

export const SOUNDS: Record<SoundId, SoundSpec> = {
  // ---- combat ----
  meleeClank: {
    category: 'combat', priority: 1, retriggerMs: 60, randomizeDetune: 120,
    layers: [
      { type: 'osc', wave: 'square', freq: 480, peak: 0.14, attack: 0.002, decay: 0.09, filter: { kind: 'highpass', freq: 1200 } },
      { type: 'osc', wave: 'square', freq: 725, peak: 0.1, attack: 0.002, decay: 0.09, filter: { kind: 'highpass', freq: 1200 } },
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.01, filter: { kind: 'highpass', freq: 3000 } },
    ],
  },
  arrowFire: {
    category: 'combat', priority: 1, retriggerMs: 45,
    layers: [
      { type: 'noise', peak: 0.18, attack: 0.004, decay: 0.076, filter: { kind: 'bandpass', freq: 1800, freqEnd: 600, q: 1.2 } },
      { type: 'osc', wave: 'triangle', freq: 900, freqEnd: 300, glide: 0.06, peak: 0.12, attack: 0.004, decay: 0.056 },
    ],
  },
  axeThrow: {
    category: 'combat', priority: 1, retriggerMs: 90,
    layers: [
      { type: 'noise', peak: 0.2, attack: 0.004, decay: 0.136, filter: { kind: 'bandpass', freq: 900, freqEnd: 350, q: 1.0 } },
      { type: 'osc', wave: 'triangle', freq: 220, vibratoHz: 5, vibratoDepth: 30, peak: 0.1, attack: 0.006, decay: 0.134 },
    ],
  },
  projImpactArrow: {
    category: 'combat', priority: 1, retriggerMs: 80,
    layers: [
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.039, filter: { kind: 'lowpass', freq: 700 } },
      { type: 'osc', wave: 'sine', freq: 200, peak: 0.1, attack: 0.001, decay: 0.05 },
    ],
  },
  projImpactAxe: {
    category: 'combat', priority: 1, retriggerMs: 80,
    layers: [
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.06, filter: { kind: 'lowpass', freq: 600 } },
      { type: 'osc', wave: 'sine', freq: 150, peak: 0.16, attack: 0.001, decay: 0.09 },
    ],
  },
  unitDeath: {
    category: 'combat', priority: 1, retriggerMs: 100,
    layers: [
      { type: 'osc', wave: 'sine', freq: 110, freqEnd: 55, glide: 0.12, peak: 0.25, attack: 0.004, decay: 0.116 },
      { type: 'noise', peak: 0.15, attack: 0.003, decay: 0.097, filter: { kind: 'lowpass', freq: 400 } },
    ],
  },
  buildingCollapse: {
    category: 'combat', priority: 1, retriggerMs: 400,
    layers: [
      { type: 'noise', peak: 0.35, attack: 0.005, decay: 0.45, filter: { kind: 'lowpass', freq: 200, q: 0.7 } },
      { type: 'osc', wave: 'sine', freq: 60, freqEnd: 35, glide: 0.5, peak: 0.3, attack: 0.005, decay: 0.5 },
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.014, delay: 0.06, filter: { kind: 'bandpass', freq: 2000, q: 2 } },
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.014, delay: 0.14, filter: { kind: 'bandpass', freq: 2000, q: 2 } },
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.014, delay: 0.23, filter: { kind: 'bandpass', freq: 2000, q: 2 } },
    ],
  },

  // ---- econ / world-scan loops ----
  sheepBaa: {
    category: 'econ', priority: 1, retriggerMs: 400,
    layers: [
      { type: 'osc', wave: 'sawtooth', freqPath: [[0, 600], [0.15, 500], [0.3, 650]], vibratoHz: 30, vibratoDepth: 14, peak: 0.08, attack: 0.02, decay: 0.28 },
    ],
  },
  woodChop: {
    category: 'econ', priority: 1, retriggerMs: 110,
    layers: [
      { type: 'noise', peak: 0.1, attack: 0.001, decay: 0.03, filter: { kind: 'bandpass', freq: 1200, q: 2 } },
      { type: 'osc', wave: 'sine', freq: 180, peak: 0.12, attack: 0.001, decay: 0.05 },
    ],
  },
  mineTink: {
    category: 'econ', priority: 1, retriggerMs: 110,
    layers: [
      { type: 'osc', wave: 'triangle', freq: 2400, detuneCents: -17, peak: 0.06, attack: 0.001, decay: 0.09 },
      { type: 'osc', wave: 'triangle', freq: 3170, detuneCents: 17, peak: 0.05, attack: 0.001, decay: 0.09 },
    ],
  },
  buildTap: {
    category: 'econ', priority: 1, retriggerMs: 110,
    layers: [
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.03, filter: { kind: 'bandpass', freq: 700, q: 1.5 } },
      { type: 'osc', wave: 'triangle', freq: 180, peak: 0.1, attack: 0.001, decay: 0.03 },
    ],
  },
  forageSwish: {
    category: 'econ', priority: 1, retriggerMs: 110,
    layers: [
      { type: 'noise', peak: 0.07, attack: 0.01, decay: 0.09, filter: { kind: 'lowpass', freq: 400 } },
    ],
  },
  resourceDepleted: {
    category: 'econ', priority: 1, retriggerMs: 110,
    layers: [
      { type: 'noise', peak: 0.1, attack: 0.005, decay: 0.175, filter: { kind: 'lowpass', freq: 600 } },
    ],
  },

  // ---- notify ----
  hornAlert: {
    category: 'notify', priority: 2, retriggerMs: 12000, centered: true,
    layers: [
      { type: 'osc', wave: 'sawtooth', freq: 196, peak: 0.11, attack: 0.3, decay: 0.6, filter: { kind: 'lowpass', freq: 900 } },
      { type: 'osc', wave: 'sawtooth', freq: 207.6, peak: 0.11, attack: 0.3, decay: 0.6, filter: { kind: 'lowpass', freq: 900 } },
    ],
  },
  villagerPop: {
    category: 'notify', priority: 2, retriggerMs: 150,
    layers: [{ type: 'osc', wave: 'sine', freq: 520, freqEnd: 660, glide: 0.09, peak: 0.14, attack: 0.005, decay: 0.085 }],
  },
  militaryReady: {
    category: 'notify', priority: 2, retriggerMs: 150,
    layers: [{ type: 'osc', wave: 'square', freq: 330, freqEnd: 415, glide: 0.11, peak: 0.14, attack: 0.005, decay: 0.105, filter: { kind: 'lowpass', freq: 1200 } }],
  },
  buildPlaced: {
    category: 'notify', priority: 2, retriggerMs: 200,
    layers: [
      { type: 'osc', wave: 'triangle', freq: 180, peak: 0.15, attack: 0.001, decay: 0.03 },
      { type: 'noise', peak: 0.1, attack: 0.001, decay: 0.03, filter: { kind: 'bandpass', freq: 800, q: 1.2 } },
    ],
  },
  constructionDone: {
    category: 'notify', priority: 2, retriggerMs: 200,
    layers: [
      { type: 'osc', wave: 'triangle', freq: 180, peak: 0.18, attack: 0.001, decay: 0.05 },
      { type: 'osc', wave: 'triangle', freq: 240, peak: 0.18, attack: 0.001, decay: 0.05, delay: 0.11 },
      { type: 'noise', peak: 0.1, attack: 0.001, decay: 0.03, filter: { kind: 'bandpass', freq: 800, q: 1.2 } },
    ],
  },
  researchDing: {
    category: 'notify', priority: 2, retriggerMs: 300,
    layers: [
      { type: 'osc', wave: 'sine', freq: 880, peak: 0.06, attack: 0.004, decay: 0.7 },
      { type: 'osc', wave: 'sine', freq: 1760, peak: 0.05, attack: 0.004, decay: 0.7 },
      { type: 'osc', wave: 'sine', freq: 2637, peak: 0.04, attack: 0.004, decay: 0.7 },
    ],
  },
  playerDefeated: {
    category: 'notify', priority: 3, retriggerMs: 400, centered: true,
    layers: [{ type: 'osc', wave: 'sine', freq: 220, peak: 0.2, attack: 0.01, decay: 0.99 }],
  },

  // ---- fanfare / stings ----
  ageFeudal: ageFanfare(196, 1600),
  ageCastle: ageFanfare(233.1, 1600),
  ageImperial: ageFanfare(261.6, 1600),
  enemyAgeFeudal: ageFanfare(196, 700),
  enemyAgeCastle: ageFanfare(233.1, 700),
  enemyAgeImperial: ageFanfare(261.6, 700),
  matchWon: {
    category: 'fanfare', priority: 3, retriggerMs: 0, centered: true,
    layers: [
      // Ascending C5-E5-G5-C6, triangle + saw, 200 ms apart.
      ...([523, 659, 784, 1046].flatMap((f, k): Layer[] => [
        { type: 'osc', wave: 'triangle', freq: f, peak: 0.09, attack: 0.006, decay: 0.24, delay: k * 0.2 },
        { type: 'osc', wave: 'sawtooth', freq: f, peak: 0.05, attack: 0.006, decay: 0.24, delay: k * 0.2, filter: { kind: 'lowpass', freq: 2200 } },
      ])),
      // Sustained major triad pad.
      { type: 'osc', wave: 'sawtooth', freq: 523, peak: 0.06, attack: 0.3, decay: 1.5, delay: 0.8, filter: { kind: 'lowpass', freq: 1600 } },
      { type: 'osc', wave: 'sawtooth', freq: 659, peak: 0.06, attack: 0.3, decay: 1.5, delay: 0.8, filter: { kind: 'lowpass', freq: 1600 } },
      { type: 'osc', wave: 'sawtooth', freq: 784, peak: 0.06, attack: 0.3, decay: 1.5, delay: 0.8, filter: { kind: 'lowpass', freq: 1600 } },
    ],
  },
  matchLost: {
    category: 'fanfare', priority: 3, retriggerMs: 0, centered: true,
    layers: [
      // Descending A4-F4-C4 sawtooth, lowpass 900, 300 ms spacing.
      ...([440, 349, 262].flatMap((f, k): Layer[] => [
        { type: 'osc', wave: 'sawtooth', freq: f, peak: 0.1, attack: 0.008, decay: 0.32, delay: k * 0.3, filter: { kind: 'lowpass', freq: 900 } },
      ])),
      // Ending 55 Hz rumble.
      { type: 'osc', wave: 'sine', freq: 55, peak: 0.15, attack: 0.02, decay: 1.0, delay: 0.9 },
    ],
  },

  // ---- ui + acks ----
  reject: {
    category: 'ui', priority: 2, retriggerMs: 300,
    layers: [{ type: 'osc', wave: 'triangle', freq: 160, peak: 0.18, attack: 0.001, decay: 0.069, filter: { kind: 'lowpass', freq: 500 } }],
  },
  uiClick: {
    category: 'ui', priority: 2, retriggerMs: 45,
    layers: [{ type: 'osc', wave: 'square', freq: 660, peak: 0.07, attack: 0.001, decay: 0.034, filter: { kind: 'highpass', freq: 400 } }],
  },
  selVillager: {
    category: 'ui', priority: 2, retriggerMs: 200, randomizeDetune: 30,
    layers: [{ type: 'osc', wave: 'sawtooth', freq: 240, freqEnd: 190, glide: 0.1, peak: 0.12, attack: 0.008, decay: 0.11, filter: { kind: 'bandpass', freq: 900, q: 4 } }],
  },
  selMilitary: {
    category: 'ui', priority: 2, retriggerMs: 200, randomizeDetune: 30,
    layers: [
      { type: 'osc', wave: 'sawtooth', freq: 170, freqEnd: 140, glide: 0.1, peak: 0.12, attack: 0.008, decay: 0.11, filter: { kind: 'bandpass', freq: 700, q: 4 } },
      { type: 'noise', peak: 0.07, attack: 0.001, decay: 0.02, filter: { kind: 'highpass', freq: 3000 } },
    ],
  },
  ackMove: {
    category: 'ui', priority: 2, retriggerMs: 200,
    layers: [
      { type: 'osc', wave: 'sine', freq: 330, peak: 0.1, attack: 0.003, decay: 0.06 },
      { type: 'osc', wave: 'sine', freq: 392, peak: 0.1, attack: 0.003, decay: 0.06, delay: 0.09 },
    ],
  },
  ackAttack: {
    category: 'ui', priority: 2, retriggerMs: 200,
    layers: [
      { type: 'osc', wave: 'sawtooth', freq: 150, peak: 0.12, attack: 0.004, decay: 0.096, filter: { kind: 'lowpass', freq: 900 } },
      { type: 'noise', peak: 0.08, attack: 0.001, decay: 0.02, filter: { kind: 'highpass', freq: 2000 } },
    ],
  },
  ackGather: {
    category: 'ui', priority: 2, retriggerMs: 200, randomizeDetune: 30,
    layers: [{ type: 'osc', wave: 'sawtooth', freq: 220, freqEnd: 180, glide: 0.09, peak: 0.11, attack: 0.006, decay: 0.09, filter: { kind: 'bandpass', freq: 850, q: 4 } }],
  },
  ackBuild: {
    category: 'ui', priority: 2, retriggerMs: 200,
    layers: [
      { type: 'noise', peak: 0.12, attack: 0.001, decay: 0.03, filter: { kind: 'bandpass', freq: 700, q: 1.5 } },
      { type: 'osc', wave: 'triangle', freq: 180, peak: 0.1, attack: 0.001, decay: 0.03 },
    ],
  },
  ackTrain: {
    category: 'ui', priority: 2, retriggerMs: 200,
    layers: [{ type: 'osc', wave: 'square', freq: 660, peak: 0.07, attack: 0.001, decay: 0.034, filter: { kind: 'highpass', freq: 400 } }],
  },
};
