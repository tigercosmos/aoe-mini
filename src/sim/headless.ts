// T4 sim engine — headless AI-vs-AI match runner (CI merge gate).
// Does NOT import src/ai (review requiredChanges #13): the caller supplies an aiFactory
// (the integration test passes T6's createAIPlayer).
import { DEFAULT_MAX_TICKS } from '../shared/constants';
import { MatchStatus } from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { Command } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import type { AIConfig, AIPlayer, MatchResult, MatchSetup } from '../shared/interfaces';
import { hashWorld } from '../core/hash';
import { createWorld } from './world';
import { stepWorld } from './step-default';

export type AIFactory = (
  player: PlayerId,
  seed: number,
  cfg?: Partial<AIConfig>,
) => AIPlayer;

/**
 * Run a full headless match. `aiFactory` is REQUIRED (typed optional only to keep the pinned
 * argument order `setup, maxTicks?, aiConfig?, aiFactory`; it throws if omitted). Every player
 * 1..N is AI-controlled. Per tick: gather commands from AIs in ascending player order, step the
 * world, and log playerDefeated/matchEnded events. Stops at Ended or maxTicks; the returned
 * checksum is hashWorld at the final tick.
 */
export function runHeadlessMatch(
  setup: MatchSetup,
  maxTicks: number = DEFAULT_MAX_TICKS,
  aiConfig?: Partial<AIConfig>,
  aiFactory?: AIFactory,
): MatchResult {
  if (aiFactory === undefined) {
    throw new Error('runHeadlessMatch requires an aiFactory');
  }

  const world = createWorld(setup);

  const ais: AIPlayer[] = [];
  for (let p = 1; p < world.players.length; p++) {
    ais.push(aiFactory(p as PlayerId, setup.seed, aiConfig));
  }

  const logEvents: GameEvent[] = [];

  while (world.tick < maxTicks && world.status !== MatchStatus.Ended) {
    const cmds: Command[] = [];
    for (let a = 0; a < ais.length; a++) {
      const issued = ais[a].think(world);
      for (let k = 0; k < issued.length; k++) cmds.push(issued[k]);
    }
    const evs = stepWorld(world, cmds);
    for (let e = 0; e < evs.length; e++) {
      const ev = evs[e];
      if (ev.type === 'playerDefeated' || ev.type === 'matchEnded') logEvents.push(ev);
    }
  }

  return {
    winner: world.winner,
    ticks: world.tick,
    checksum: hashWorld(world),
    events: logEvents,
  };
}
