// T4 sim engine — world construction.
import {
  DEFAULT_MAP_SIZE,
  MAX_ENTITIES,
  STARTING_RESOURCES,
  STARTING_VILLAGERS,
  tileXOf,
  tileYOf,
} from '../shared/constants';
import {
  Age,
  BuildingType,
  CivId,
  GAIA,
  MatchStatus,
  RESOURCE_COUNT,
  TECH_COUNT,
  UnitType,
} from '../shared/enums';
import type { PlayerId } from '../shared/enums';
import type { System } from '../shared/interfaces';
import type { MatchSetup } from '../shared/interfaces';
import type { PlayerState, World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import { createRng } from '../shared/rng';
import { createEntityManager } from '../core/entities';
import { createComponentStores } from '../core/components';
import { createSpatialGrid } from '../core/spatial';
import { createTileMap } from '../map/tilemap';
import { createPathCache } from '../map/pathcache';
import { generateMap } from '../map/mapgen';
import { adjacentSpawnTile } from '../map/tilemap';
import { spawnBuilding, spawnUnit } from './actions';

// Note on the optional `updateVisibility` argument (review requiredChanges #4/#6):
// src/map/visibility is imported ONLY by src/sim/step-default.ts, so createWorld cannot import
// it directly. Callers that want initial fog (the browser bootstrap) inject it; determinism and
// checksums are unaffected by visibility, and stepWorld recomputes fog on tick % 5 regardless.
export function createWorld(setup: MatchSetup, updateVisibility?: System): World {
  const seed = setup.seed;
  const mapSize = setup.mapSize ?? DEFAULT_MAP_SIZE;
  const playerCount = setup.players.length;

  const em = createEntityManager(MAX_ENTITIES);
  const comp = createComponentStores(MAX_ENTITIES);
  const map = createTileMap(mapSize);
  const grid = createSpatialGrid(mapSize);
  const pathCache = createPathCache();
  const rng = createRng(seed);

  const players: PlayerState[] = [];
  // Slot 0 = Gaia (review requiredChanges #17d).
  players.push({
    id: GAIA,
    civ: CivId.Britons,
    isAI: false,
    alive: false,
    resources: new Float32Array(RESOURCE_COUNT),
    population: 0,
    populationCap: 0,
    age: Age.Dark,
    researched: new Uint8Array(TECH_COUNT),
    statsVersion: 0,
  });
  for (let p = 1; p <= playerCount; p++) {
    const ps = setup.players[p - 1];
    const resources = new Float32Array(RESOURCE_COUNT);
    for (let r = 0; r < RESOURCE_COUNT; r++) resources[r] = STARTING_RESOURCES[r];
    players.push({
      id: p,
      civ: ps.civ,
      isAI: ps.isAI,
      alive: true,
      resources,
      population: 0,
      populationCap: 0,
      age: Age.Dark,
      researched: new Uint8Array(TECH_COUNT),
      statsVersion: 0,
    });
  }

  const world: World = {
    tick: 0,
    seed,
    rng,
    mapSize,
    em,
    comp,
    map,
    grid,
    pathCache,
    players,
    events: [],
    status: MatchStatus.Running,
    winner: -1,
  };

  const gen = generateMap(map, rng, playerCount);

  // Per-player starting buildings + units.
  const TC = BuildingType.TownCenter;
  const startUnits: UnitType[] = [];
  for (let v = 0; v < STARTING_VILLAGERS; v++) startUnits.push(UnitType.Villager);
  startUnits.push(UnitType.ScoutCavalry);
  // Deterministic offsets applied to the single adjacentSpawnTile anchor so the starting
  // units occupy distinct nearby tiles (the 12x12 start clearing guarantees walkability).
  const offsets: readonly [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 0],
  ];

  for (let p = 1; p <= playerCount; p++) {
    const start = gen.starts[p - 1];
    const tcHandle = spawnBuilding(world, p as PlayerId, TC, start.x, start.y, true);
    const tcIdx = resolveHandle(em, tcHandle);
    const fsX = tcIdx >= 0 ? comp.sizeX[tcIdx] : 4;
    const fsY = tcIdx >= 0 ? comp.sizeY[tcIdx] : 4;

    const anchor = adjacentSpawnTile(map, start.x, start.y, fsX, fsY);
    let bx: number;
    let by: number;
    if (anchor >= 0) {
      bx = tileXOf(mapSize, anchor);
      by = tileYOf(mapSize, anchor);
    } else {
      bx = Math.max(0, start.x - 1);
      by = start.y;
    }
    for (let k = 0; k < startUnits.length; k++) {
      const off = offsets[k % offsets.length];
      let tx = bx + off[0];
      let ty = by + off[1];
      if (tx < 0) tx = 0;
      if (ty < 0) ty = 0;
      if (tx >= mapSize) tx = mapSize - 1;
      if (ty >= mapSize) ty = mapSize - 1;
      spawnUnit(world, p as PlayerId, startUnits[k], tx + 0.5, ty + 0.5);
    }
  }

  // Gaia sheep.
  for (let s = 0; s < gen.sheep.length; s++) {
    const sp = gen.sheep[s];
    spawnUnit(world, GAIA, UnitType.Sheep, sp.x, sp.y);
  }

  grid.rebuild(em, comp);
  if (updateVisibility) updateVisibility(world);

  return world;
}
