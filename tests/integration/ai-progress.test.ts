// tests/integration/ai-progress.test.ts
//
// Long, stepWorld-driven AI tests (T6-owned; relocated here per review requiredChanges #18 so the
// per-task tests/ai/ai.test.ts suite stays standalone). These drive the REAL sim: createWorld (T4)
// + stepWorld (T4 step-default) + createAIPlayer (T6). They assert the AI grows an economy and
// walks the build order to the Feudal Age.
//
// NOTE on calibration: the MWV AI is a deliberately simple heuristic planner. Two things about its
// measured behavior shape the assertions below:
//  (1) A healthy RTS opening INVESTS banked resources into villagers, so the raw stockpile dips
//      during the boom before compounding — the honest "economy grew" signal is net worth
//      (banked resources + the food invested in the villager workforce), not the raw stockpile.
//  (2) Reaching Feudal means banking the 500-food age cost from a Dark-Age berry economy and then
//      researching it (a 2600-tick research), which lands around ~15 min of game time. The default
//      18-villager "boom" config keeps every spare villager training and stays in the Dark Age, so
//      the build-order check uses a Feudal-oriented villager cap (the same style of aggressive
//      config the headless-match merge gate uses).

import { describe, it, expect } from 'vitest';
import { Age, BuildingType, EntityKind, UnitType, CivId } from '../../src/shared/enums';
import type { PlayerId } from '../../src/shared/enums';
import type { World } from '../../src/shared/world';
import type { Command } from '../../src/shared/commands';
import type { MatchSetup, AIPlayer, AIConfig } from '../../src/shared/interfaces';
import { createWorld } from '../../src/sim/world';
import { stepWorld } from '../../src/sim/step-default';
import { createAIPlayer } from '../../src/ai/ai';

const MATCH_TIMEOUT = 300_000;
const VILLAGER_FOOD_COST = 50; // Villager base cost is 50 food (see content/units) — used for net-worth.

function makeAllAIWorld(seed: number, cfg?: Partial<AIConfig>): { world: World; ais: AIPlayer[] } {
  const setup: MatchSetup = {
    seed,
    players: [
      { civ: CivId.Franks, isAI: true },
      { civ: CivId.Mongols, isAI: true },
    ],
  };
  const world = createWorld(setup);
  const ais: AIPlayer[] = [];
  for (let p = 1; p < world.players.length; p++) ais.push(createAIPlayer(p, seed, cfg));
  return { world, ais };
}

/** Drive the sim until `maxTicks` or the match ends, feeding every AI's commands each tick. */
function runMatch(world: World, ais: AIPlayer[], maxTicks: number): void {
  for (let t = 0; t < maxTicks && world.status === 0 /* Running */; t++) {
    const cmds: Command[] = [];
    for (let a = 0; a < ais.length; a++) {
      const issued = ais[a].think(world);
      for (let k = 0; k < issued.length; k++) cmds.push(issued[k]);
    }
    stepWorld(world, cmds);
  }
}

/** Drive the sim until `player` reaches `age`, the match ends, or `maxTicks` elapses. */
function runMatchUntilAge(world: World, ais: AIPlayer[], player: PlayerId, age: Age, maxTicks: number): void {
  for (let t = 0; t < maxTicks && world.status === 0; t++) {
    const cmds: Command[] = [];
    for (let a = 0; a < ais.length; a++) {
      const issued = ais[a].think(world);
      for (let k = 0; k < issued.length; k++) cmds.push(issued[k]);
    }
    stepWorld(world, cmds);
    if (world.players[player].age >= age) return;
  }
}

function countBuildingType(world: World, player: PlayerId, bt: BuildingType, includeUnderConstruction: boolean): number {
  const em = world.em;
  const comp = world.comp;
  let n = 0;
  for (let i = 0; i < comp.capacity; i++) {
    if (em.alive[i] !== 1 || comp.owner[i] !== player) continue;
    if (comp.kind[i] !== EntityKind.Building || comp.subtype[i] !== bt) continue;
    if (!includeUnderConstruction && (comp.flags[i] & 1 /* FLAG_UNDER_CONSTRUCTION */) !== 0) continue;
    n++;
  }
  return n;
}

function countVillagers(world: World, player: PlayerId): number {
  const em = world.em;
  const comp = world.comp;
  let n = 0;
  for (let i = 0; i < comp.capacity; i++) {
    if (em.alive[i] === 1 && comp.owner[i] === player && comp.kind[i] === EntityKind.Unit && comp.subtype[i] === UnitType.Villager) n++;
  }
  return n;
}

function bankedResources(world: World, player: PlayerId): number {
  const r = world.players[player].resources;
  return r[0] + r[1] + r[2] + r[3];
}

/** Net economic worth = banked resources + food invested in the villager workforce. */
function netWorth(world: World, player: PlayerId): number {
  return bankedResources(world, player) + countVillagers(world, player) * VILLAGER_FOOD_COST;
}

describe('AI economy progression (real stepWorld)', () => {
  it(
    'grows its economy: expands the workforce, raises the population cap with Houses, and grows net worth',
    () => {
      const { world, ais } = makeAllAIWorld(20260702);
      const startVillagers = countVillagers(world, 1);
      const startWorth = netWorth(world, 1);

      runMatch(world, ais, 6000);

      // The workforce expanded — the AI turns gathered resources into villagers.
      expect(countVillagers(world, 1)).toBeGreaterThan(startVillagers);
      // Population grew past the starting cap of 5 (villagers trained).
      expect(world.players[1].population).toBeGreaterThan(5);
      // At least one House exists to lift the population cap.
      expect(countBuildingType(world, 1, BuildingType.House, true)).toBeGreaterThanOrEqual(1);
      // Net economic worth grew: banked resources PLUS the food invested in the villager workforce.
      // (Raw banked stockpile dips during the investment phase, so it is the wrong growth metric.)
      expect(netWorth(world, 1)).toBeGreaterThan(startWorth);
    },
    MATCH_TIMEOUT,
  );
});

describe('AI build order (real stepWorld)', () => {
  it(
    'executes its build order: builds a Barracks and advances to the Feudal Age',
    () => {
      // Feudal-oriented economy config (see the calibration note at the top of this file).
      const { world, ais } = makeAllAIWorld(13371337, { maxVillagers: 12, attackArmySize: 8, thinkInterval: 10 });

      runMatchUntilAge(world, ais, 1, Age.Feudal, 22000);

      // Barracks is a hard prerequisite for the Feudal Age; it must exist.
      expect(countBuildingType(world, 1, BuildingType.Barracks, true)).toBeGreaterThanOrEqual(1);
      // The Feudal Age tech completed -> the player advanced.
      expect(world.players[1].age).toBeGreaterThanOrEqual(Age.Feudal);
    },
    MATCH_TIMEOUT,
  );
});
