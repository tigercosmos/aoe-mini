// T4 sim engine — defeat + victory resolution (review requiredChanges #15).
import { BuildingType, EntityKind, MatchStatus } from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { World } from '../shared/world';
import { emit } from './actions';

/** Mark newly-defeated players (zero alive Town Centers OR zero alive entities), emitting
 *  `playerDefeated` once each. Then, if <= 1 non-Gaia players remain, end the match:
 *  aliveCount === 1 -> matchEnded{winner}; aliveCount === 0 -> matchEnded{winner:-1}. */
export function victorySystem(world: World): void {
  if (world.status === MatchStatus.Ended) return;

  const { comp, em, players } = world;
  const cap = comp.capacity;
  const n = players.length;

  // Tally alive TownCenters and total entities per (non-Gaia) player in one ascending pass.
  const tcCount = new Int32Array(n);
  const entCount = new Int32Array(n);
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    const kind = comp.kind[i];
    if (kind === EntityKind.Projectile) continue;
    const owner = comp.owner[i];
    if (owner <= 0 || owner >= n) continue; // ignore Gaia / out-of-range
    entCount[owner]++;
    if (kind === EntityKind.Building && comp.subtype[i] === BuildingType.TownCenter) {
      tcCount[owner]++;
    }
  }

  for (let p = 1; p < n; p++) {
    if (!players[p].alive) continue;
    if (tcCount[p] === 0 || entCount[p] === 0) {
      players[p].alive = false;
      emit(world, { type: 'playerDefeated', player: p as PlayerId });
    }
  }

  let aliveCount = 0;
  let winner: PlayerId = -1;
  for (let p = 1; p < n; p++) {
    if (players[p].alive) {
      aliveCount++;
      winner = p;
    }
  }

  if (aliveCount <= 1) {
    if (aliveCount !== 1) winner = -1;
    world.status = MatchStatus.Ended;
    world.winner = winner;
    emit(world, { type: 'matchEnded', winner });
  }
}
