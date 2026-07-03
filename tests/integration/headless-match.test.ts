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

// Tick cap for the gate. The redesigned AI (src/ai) banks for age-up and plays a full, defensively
// sound economic game — it defends its base, masses armies and grinds down fortified Town Centers,
// so a decisive 3-player FFA runs longer than the old all-in rusher's ~30 min. On this seed it
// resolves decisively at ~tick 37,800; 45,000 (37.5 min) gives comfortable headroom. The match ends
// the instant one player remains, so a decisive game costs the same wall-clock regardless of this cap.
const MATCH_CAP = 45_000;

describe('headless AI-vs-AI match (integration merge gate)', () => {
  it('produces a decisive winner and reproduces identically on a second run', () => {
    const r1 = runHeadlessMatch(SETUP, MATCH_CAP, CFG, createAIPlayer);

    expect([1, 2, 3]).toContain(r1.winner);
    expect(r1.events.some((e) => e.type === 'playerDefeated')).toBe(true);
    expect(r1.events.some((e) => e.type === 'matchEnded' && e.winner === r1.winner)).toBe(true);
    expect(r1.ticks).toBeGreaterThan(0);
    expect(r1.ticks).toBeLessThanOrEqual(MATCH_CAP);

    const r2 = runHeadlessMatch(SETUP, MATCH_CAP, CFG, createAIPlayer);
    expect(r2.winner).toBe(r1.winner);
    expect(r2.ticks).toBe(r1.ticks);
    expect(r2.checksum).toBe(r1.checksum);
  }, 300_000);

  it('requires an aiFactory', () => {
    // aiFactory is typed optional only to preserve the pinned argument order; omitting it throws.
    expect(() => runHeadlessMatch(SETUP, 100, CFG)).toThrow();
  });
});
