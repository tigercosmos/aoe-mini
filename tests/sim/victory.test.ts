import { describe, it, expect } from 'vitest';
import { createWorld } from '../../src/sim/world';
import { victorySystem } from '../../src/sim/victory';
import { deathSystem } from '../../src/sim/death';
import { spawnBuilding } from '../../src/sim/actions';
import { BuildingType, CivId, EntityKind, MatchStatus } from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { World } from '../../src/shared/world';

function mkWorld(): World {
  return createWorld({
    seed: 3,
    mapSize: 48,
    players: [
      { civ: CivId.Britons, isAI: false },
      { civ: CivId.Franks, isAI: false },
    ],
  });
}

function tcIndicesOf(w: World, player: PlayerId): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.comp.capacity; i++) {
    if (w.em.alive[i] !== 1) continue;
    if (w.comp.kind[i] !== EntityKind.Building) continue;
    if (w.comp.owner[i] !== player) continue;
    if (w.comp.subtype[i] !== BuildingType.TownCenter) continue;
    out.push(i);
  }
  return out;
}

describe('victorySystem', () => {
  it('defeats a player with zero Town Centers and ends the match with the survivor', () => {
    const w = mkWorld();
    // Destroy player 2's only TC.
    for (const idx of tcIndicesOf(w, 2)) w.comp.hp[idx] = 0;
    w.events.length = 0;
    deathSystem(w);
    victorySystem(w);

    expect(w.players[2].alive).toBe(false);
    expect(w.events.some((e) => e.type === 'playerDefeated' && e.player === 2)).toBe(true);
    expect(w.status).toBe(MatchStatus.Ended);
    expect(w.winner).toBe(1);
    expect(w.events.some((e) => e.type === 'matchEnded' && e.winner === 1)).toBe(true);
  });

  it('keeps a player alive while at least one Town Center survives', () => {
    const w = mkWorld();
    // Give player 2 a second TC in a corner, then destroy the original.
    spawnBuilding(w, 2, BuildingType.TownCenter, 0, 0, true);
    const originals = tcIndicesOf(w, 2).filter((i) => Math.round(w.comp.posX[i] - 2) !== 0);
    for (const idx of originals) w.comp.hp[idx] = 0;
    w.events.length = 0;
    deathSystem(w);
    victorySystem(w);

    expect(w.players[2].alive).toBe(true);
    expect(w.status).toBe(MatchStatus.Running);
    expect(w.events.some((e) => e.type === 'matchEnded')).toBe(false);
  });

  it('ends with winner -1 when the last two players die on the same tick', () => {
    const w = mkWorld();
    for (const idx of tcIndicesOf(w, 1)) w.comp.hp[idx] = 0;
    for (const idx of tcIndicesOf(w, 2)) w.comp.hp[idx] = 0;
    w.events.length = 0;
    deathSystem(w);
    victorySystem(w);

    expect(w.players[1].alive).toBe(false);
    expect(w.players[2].alive).toBe(false);
    expect(w.status).toBe(MatchStatus.Ended);
    expect(w.winner).toBe(-1);
    expect(w.events.some((e) => e.type === 'matchEnded' && e.winner === -1)).toBe(true);
  });

  it('is idempotent once ended', () => {
    const w = mkWorld();
    for (const idx of tcIndicesOf(w, 2)) w.comp.hp[idx] = 0;
    deathSystem(w);
    victorySystem(w);
    w.events.length = 0;
    victorySystem(w); // second call must not re-emit / re-decide
    expect(w.events.length).toBe(0);
  });
});
