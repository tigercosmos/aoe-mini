/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { createStepper } from '../../src/sim/tick';
import { hashWorld } from '../../src/core/hash';
import { CivId, EntityKind, UnitType } from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { Command } from '../../src/shared/commands';
import type { World } from '../../src/shared/world';
import type { SystemSet } from '../../src/shared/interfaces';

const NOOP_SYSTEMS: SystemSet = {
  production: () => {},
  villager: () => {},
  combat: () => {},
  projectile: () => {},
};

function buildWorld(): World {
  return createWorld({
    seed: 4242,
    mapSize: 48,
    players: [
      { civ: CivId.Britons, isAI: false },
      { civ: CivId.Franks, isAI: false },
      { civ: CivId.Mongols, isAI: false },
    ],
  });
}

function villagerHandles(w: World, player: PlayerId): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] !== EntityKind.Unit) continue;
    if (w.comp.owner[i] !== player) continue;
    if (w.comp.subtype[i] !== UnitType.Villager) continue;
    out.push(w.em.handleFor(i));
  }
  return out;
}

// Scripted commands: send every player's villagers on a diagonal march on the very first step.
function makeMoveCommands(w: World): Command[] {
  const cmds: Command[] = [];
  for (let p = 1; p <= 3; p++) {
    const vs = villagerHandles(w, p as PlayerId);
    if (vs.length === 0) continue;
    const leadIdx = vs[0] & 0xfff; // handle -> index for reading a start position
    cmds.push({
      type: 'move',
      player: p as PlayerId,
      units: vs,
      x: w.comp.posX[leadIdx] + 6,
      y: w.comp.posY[leadIdx] + 6,
    });
  }
  return cmds;
}

describe('sim determinism (fake systems)', () => {
  it('produces identical world checksums across two runs with the same seed + scripted commands', () => {
    const TICKS = 300;
    const wA = buildWorld();
    const wB = buildWorld();
    const cmds0 = makeMoveCommands(wA); // handles are identical across same-seed worlds

    // Sanity: same-seed worlds start byte-identical.
    expect(hashWorld(wA)).toBe(hashWorld(wB));

    const stepA = createStepper(NOOP_SYSTEMS);
    const stepB = createStepper(NOOP_SYSTEMS);

    const checkpointsA: number[] = [];
    const checkpointsB: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      stepA(wA, t === 0 ? cmds0 : []);
      stepB(wB, t === 0 ? cmds0 : []);
      if ((t + 1) % 50 === 0) {
        checkpointsA.push(hashWorld(wA));
        checkpointsB.push(hashWorld(wB));
      }
    }

    expect(checkpointsA).toEqual(checkpointsB);
    // The world genuinely evolves (units marched) rather than being a frozen constant.
    expect(new Set(checkpointsA).size).toBeGreaterThan(1);
  });
});

// --- Static source scan (determinism guard) -------------------------------------------------
// Read every sim-layer source file as raw text via Vite's import.meta.glob (ESM-native; avoids
// node:fs so it typechecks under the foundation tsconfig's `types: []`).
const RAW_SOURCES = import.meta.glob('/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SIM_ROOTS = ['/src/core/', '/src/map/', '/src/content/', '/src/sim/', '/src/systems/', '/src/ai/'];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('sim determinism (static scan)', () => {
  const files = Object.keys(RAW_SOURCES)
    .filter((p) => SIM_ROOTS.some((r) => p.startsWith(r)))
    .sort();
  const banned = /Math\.random|Date\.now|new Date\b|performance\.now/;
  const dom = /\bdocument\b|\bwindow\b|requestAnimationFrame/;

  it('finds simulation source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`is free of nondeterministic / DOM APIs: ${f}`, () => {
      const code = stripComments(RAW_SOURCES[f]);
      expect(banned.test(code)).toBe(false);
      expect(dom.test(code)).toBe(false);
    });
  }
});
