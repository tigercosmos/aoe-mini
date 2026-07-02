import { describe, it, expect } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { stepWorld } from '../../src/sim/step-default';
import { hashWorld } from '../../src/core/hash';
import { createAIPlayer } from '../../src/ai/ai';
import { CivId, MatchStatus } from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { Command } from '../../src/shared/commands';
import type { AIConfig, AIPlayer, MatchSetup } from '../../src/shared/interfaces';

const SETUP: MatchSetup = {
  seed: 90210,
  mapSize: 64,
  players: [
    { civ: CivId.Britons, isAI: true },
    { civ: CivId.Franks, isAI: true },
    { civ: CivId.Mongols, isAI: true },
  ],
};

const CFG: Partial<AIConfig> = { maxVillagers: 12, attackArmySize: 8, thinkInterval: 10 };

// Drive the REAL, fully-wired tick pipeline (T5 systems via step-default) with the real T6 AI,
// recording a world checksum every 50 ticks. This is the determinism oracle that exercises all
// eight modules together (review requiredChanges #4/#18).
function runCheckpoints(ticks: number): number[] {
  const world = createWorld(SETUP);
  const ais: AIPlayer[] = [];
  for (let p = 1; p < world.players.length; p++) {
    ais.push(createAIPlayer(p as PlayerId, SETUP.seed, CFG));
  }
  const checkpoints: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const cmds: Command[] = [];
    for (let a = 0; a < ais.length; a++) {
      const issued = ais[a].think(world);
      for (let k = 0; k < issued.length; k++) cmds.push(issued[k]);
    }
    stepWorld(world, cmds);
    if ((t + 1) % 50 === 0) checkpoints.push(hashWorld(world));
    if (world.status === MatchStatus.Ended) break;
  }
  return checkpoints;
}

describe('determinism with real T5 systems + T6 AI (integration)', () => {
  it('reproduces identical per-checkpoint checksums across two runs', () => {
    const a = runCheckpoints(1200);
    const b = runCheckpoints(1200);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    // The simulation genuinely advances (not a frozen constant).
    expect(new Set(a).size).toBeGreaterThan(1);
  }, 300_000);
});
