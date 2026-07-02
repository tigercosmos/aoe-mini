import { describe, it, expect } from 'vitest';
import { runHeadlessMatch } from '../../src/sim/headless';
import { createAIPlayer } from '../../src/ai/ai';
import { CivId } from '../../src/shared/enums';
import type { AIConfig, MatchSetup } from '../../src/shared/interfaces';

const SETUP: MatchSetup = {
  seed: 1234,
  mapSize: 64,
  players: [
    { civ: CivId.Britons, isAI: true },
    { civ: CivId.Franks, isAI: true },
    { civ: CivId.Mongols, isAI: true },
  ],
};

const CFG: Partial<AIConfig> = { maxVillagers: 12, attackArmySize: 8, thinkInterval: 10 };

describe('headless AI-vs-AI match (integration merge gate)', () => {
  it('produces a decisive winner and reproduces identically on a second run', () => {
    const r1 = runHeadlessMatch(SETUP, 36000, CFG, createAIPlayer);

    expect([1, 2, 3]).toContain(r1.winner);
    expect(r1.events.some((e) => e.type === 'playerDefeated')).toBe(true);
    expect(r1.events.some((e) => e.type === 'matchEnded' && e.winner === r1.winner)).toBe(true);
    expect(r1.ticks).toBeGreaterThan(0);
    expect(r1.ticks).toBeLessThanOrEqual(36000);

    const r2 = runHeadlessMatch(SETUP, 36000, CFG, createAIPlayer);
    expect(r2.winner).toBe(r1.winner);
    expect(r2.ticks).toBe(r1.ticks);
    expect(r2.checksum).toBe(r1.checksum);
  }, 300_000);

  it('requires an aiFactory', () => {
    // aiFactory is typed optional only to preserve the pinned argument order; omitting it throws.
    expect(() => runHeadlessMatch(SETUP, 100, CFG)).toThrow();
  });
});
