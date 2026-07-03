// src/ai/military.ts
//
// Military planner: build order (Barracks -> Feudal buildings -> Blacksmith -> Castle), army
// production with counter-aware composition, wave discipline (stage -> mass -> commit -> raid ->
// retreat), defense reaction, blacksmith/eco upgrades, and a deterministic scout patrol.
// Pure Command emitter — reads World only; mutates only the per-instance AIContext/AIMemory scratch.

import {
  Age,
  BuildingType,
  UnitType,
  TechId,
  ResourceNode,
  OrderType,
  EntityKind,
  GAIA,
} from '../shared/enums';
import type { PlayerId, CivId } from '../shared/enums';
import type { World, PlayerState } from '../shared/world';
import { resolveHandle } from '../shared/world';
import type { Command } from '../shared/commands';
import { tileIndex, tileXOf, tileYOf } from '../shared/constants';
import {
  BUILD_INFO,
  UNIT_INFO,
  TECH_INFO,
  MIL_QUEUE_MAX,
  PLACE_SEARCH_RADIUS,
  STAGING_FRACTION,
  RAID_RADIUS,
  EVAC_RADIUS,
  Phase,
  canAffordFree,
  canAffordBudget,
  spend,
  hasCompleted,
  existingCount,
  handleOf,
  queueLen,
  queueHasTech,
  dist2,
  findPlacement,
  findNearestNode,
  findNearestEnemyEntity,
  techReqsMet,
  uniqueUnitOf,
  pickByDeficit,
  type AIContext,
} from './ai';

const MIL_BUILD_CAP = 2;   // military buildings started per think
const MIL_TECH_CAP = 1;    // upgrade techs queued per think
const MIL_TRAIN_CAP = 4;   // train commands per think (round-robin across military buildings)

// Military production buildings, indexed 0..3 -> the class each mainly fields (0 inf, 1 arch, 2 cav).
const MILITARY_BUILDINGS: readonly BuildingType[] = [
  BuildingType.Barracks,
  BuildingType.ArcheryRange,
  BuildingType.Stable,
  BuildingType.Castle,
];

// Military building tech tree, in the order the AI wants them.
const BUILDING_ORDER: readonly BuildingType[] = [
  BuildingType.Barracks,
  BuildingType.Blacksmith,
  BuildingType.ArcheryRange,
  BuildingType.Stable,
  BuildingType.Castle,
];

// Blacksmith/eco upgrade priority (age + Loom + Wheelbarrow handled elsewhere).
const UPGRADE_ORDER: readonly TechId[] = [
  TechId.ManAtArmsUpgrade,
  TechId.Forging,
  TechId.Fletching,
  TechId.ScaleMailArmor,
  TechId.ScaleBardingArmor,
  TechId.IronCasting,
  TechId.ChainMailArmor,
  TechId.BodkinArrow,
];

/** The unit a military building should produce, honoring the anti-cavalry counter and upgrades. */
function unitForBuilding(bt: BuildingType, ps: PlayerState, counterCav: boolean): UnitType | -1 {
  switch (bt) {
    case BuildingType.Barracks:
      if (counterCav && ps.age >= Age.Feudal) return UnitType.Spearman;
      return ps.researched[TechId.ManAtArmsUpgrade] === 1 ? UnitType.ManAtArms : UnitType.Militia;
    case BuildingType.ArcheryRange:
      return UnitType.Archer;
    case BuildingType.Stable:
      return ps.age >= Age.Castle ? UnitType.Knight : UnitType.ScoutCavalry;
    case BuildingType.Castle:
      return uniqueUnitOf(ps.civ as CivId);
    default:
      return -1;
  }
}

/** Reserve a builder from the HIGH end of the shared pool + place near `nearTile`; emit or null. */
function emitBuildHigh(ctx: AIContext, building: BuildingType, nearTile: number): Command | null {
  const { world, player, builders, used, rng } = ctx;
  let builder = -1;
  for (let k = builders.length - 1; k >= 0; k--) {
    if (!used.has(builders[k])) {
      builder = builders[k];
      break;
    }
  }
  if (builder < 0) return null;
  const spot = findPlacement(world, nearTile, BUILD_INFO[building].size, rng, PLACE_SEARCH_RADIUS);
  if (!spot) return null;
  used.add(builder);
  spend(ctx.budget, BUILD_INFO[building].cost);
  return { type: 'build', player, units: [handleOf(world, builder)], building, tileX: spot.tileX, tileY: spot.tileY };
}

/** Own army handles, optionally excluding the patrol scout. */
function armyHandles(ctx: AIContext, includeScout: boolean): number[] {
  const out: number[] = [];
  for (let k = 0; k < ctx.scan.army.length; k++) {
    const i = ctx.scan.army[k];
    if (!includeScout && i === ctx.scout) continue;
    out.push(handleOf(ctx.world, i));
  }
  return out;
}

/** Commit size: explicit cfg override, else per-age preset (Dark falls back to attackArmySize). */
function waveSize(ctx: AIContext): number {
  let w: number;
  if (ctx.explicitArmy) {
    w = ctx.cfg.attackArmySize;
  } else {
    const byAge = ctx.tuning.waveSize[ctx.scan.ps.age];
    w = byAge > 0 ? byAge : ctx.cfg.attackArmySize;
  }
  // Late-game valve: halve the wave (anti-stalemate) so ahead-on-economy AIs finish the match.
  if (ctx.world.tick > ctx.tuning.lateGameTick) w = Math.max(4, w >> 1);
  return w;
}

/** Desired production-building share [barracks, range, stable, castle], counter-adjusted. */
function desiredShares(ctx: AIContext): { shares: number[]; counterCav: boolean } {
  const age = ctx.scan.ps.age;
  let shares: number[];
  if (age === Age.Dark) shares = [1, 0, 0, 0];
  else if (age === Age.Feudal) shares = [0.45, 0.35, 0.2, 0];
  else shares = [0.2, 0.3, 0.35, 0.15];

  let counterCav = false;
  if (ctx.tuning.counters) {
    const total = ctx.intel.armyCount;
    if (total > 0) {
      const [inf, arch, cav] = ctx.intel.armyByClass;
      if (cav >= 3 && cav / total >= 0.4) {
        shares[0] += 0.25;
        counterCav = true;
      } else if (inf >= 3 && inf / total >= 0.4) {
        shares[1] += 0.25; // archers outrange infantry
      } else if (arch >= 3 && arch / total >= 0.4) {
        shares[2] += 0.25; // cavalry closes on archers
      }
    }
  }
  return { shares, counterCav };
}

/** Villager evacuation: villagers within EVAC_RADIUS of the threat retreat to the TC (batched move). */
function evacuate(ctx: AIContext, threat: number): Command | null {
  const { world, player, scan } = ctx;
  const c = world.comp;
  const tx = c.posX[threat];
  const ty = c.posY[threat];
  const r2 = EVAC_RADIUS * EVAC_RADIUS;
  const units: number[] = [];
  for (let k = 0; k < scan.villagers.length; k++) {
    const i = scan.villagers[k];
    if (dist2(tx, ty, c.posX[i], c.posY[i]) <= r2) units.push(handleOf(world, i));
  }
  if (units.length === 0) return null;
  return { type: 'move', player, units, x: ctx.refX, y: ctx.refY };
}

/** Waypoint on the scout patrol ring (8 points, radius 0.3*mapSize around map center). */
function scoutWaypoint(world: World, k: number): { x: number; y: number } {
  const size = world.map.size;
  const cx = size / 2;
  const cy = size / 2;
  const r = 0.3 * size;
  const a = (2 * Math.PI * k) / 8;
  let x = cx + r * Math.cos(a);
  let y = cy + r * Math.sin(a);
  x = x < 0.5 ? 0.5 : x > size - 0.5 ? size - 0.5 : x;
  y = y < 0.5 ? 0.5 : y > size - 0.5 ? size - 0.5 : y;
  return { x, y };
}

export function planMilitary(ctx: AIContext): Command[] {
  const { world, player, scan, intel } = ctx;
  const ps = scan.ps;
  const c = world.comp;
  const cmds: Command[] = [];
  const lateGame = world.tick > ctx.tuning.lateGameTick;
  // In the late game the army commits to razing and is NOT recalled to defend — the focus-fire push
  // is the decisive win condition, so nothing may preempt it (anti-stalemate guarantee).
  const threatened = intel.threats.length > 0 && !lateGame;

  // --- 1. Defense reaction OR wave logic ------------------------------------------------------
  if (threatened && intel.nearestThreat >= 0) {
    ctx.mem.attacking = false;
    // Whole army (incl. scout — emergency) onto the nearest threat.
    const units = armyHandles(ctx, true);
    if (units.length > 0) {
      cmds.push({ type: 'attack', player, units, target: handleOf(world, intel.nearestThreat) });
    }
    // Poor-man's town bell: pull threatened villagers back under TC fire.
    const evac = evacuate(ctx, intel.nearestThreat);
    if (evac) cmds.push(evac);
  } else {
    // Wave logic, kept DELIBERATELY SIMPLE — this is what reliably razes a Town Center and actually
    // ends matches. Once the (non-scout) army reaches the wave threshold, send the WHOLE army at the
    // nearest enemy Town Center and re-issue every think so reinforcements funnel onto the same target
    // until it falls (razing a TC is the only win condition). No staging detour and no retreat latch:
    // those let entrenched enemies out-produce the incoming damage and stalemate. Below wave strength
    // we just rally new units forward (toward the enemy) so the next wave forms near the front instead
    // of trickling across the map one unit at a time. The late-game valve (halved wave) guarantees an
    // economically-ahead AI commits and finishes within the tick cap.
    const wave = waveSize(ctx);
    ctx.mem.attacking = ctx.armyCount >= wave;
    const attackUnits = armyHandles(ctx, false);
    if (ctx.mem.attacking && attackUnits.length > 0) {
      // Hard difficulty opportunistically snipes a villager right next to the army (eco raid) and
      // retargets the TC the instant no villager is close, so raids can never stall the push.
      let target = -1;
      if (ctx.tuning.raids && intel.nearestVillagerToArmy >= 0) {
        const v = intel.nearestVillagerToArmy;
        if (dist2(ctx.armyCx, ctx.armyCy, c.posX[v], c.posY[v]) <= RAID_RADIUS * RAID_RADIUS) target = v;
      }
      // STICKY focus target: keep razing the SAME enemy Town Center until it actually falls, then move
      // to the next-nearest. Without this the army splits fire across two enemies and finishes neither
      // in time; concentrating on one collapses it fast, then the next — this is what turns "everyone
      // at low HP at the tick cap" into decisive back-to-back eliminations.
      if (target < 0) {
        const focus = resolveHandle(world.em, ctx.mem.focusTarget);
        const focusValid =
          focus >= 0 &&
          c.owner[focus] !== player &&
          c.owner[focus] !== GAIA &&
          c.kind[focus] === EntityKind.Building &&
          c.subtype[focus] === BuildingType.TownCenter;
        if (focusValid) {
          target = focus;
        } else {
          target = intel.nearestTC;
          ctx.mem.focusTarget = target >= 0 ? handleOf(world, target) : -1;
        }
      }
      if (target < 0) target = findNearestEnemyEntity(world, player, ctx.refX, ctx.refY);
      if (target >= 0) {
        cmds.push({ type: 'attack', player, units: attackUnits, target: handleOf(world, target) });
      } else {
        cmds.push({ type: 'attackMove', player, units: attackUnits, x: world.map.size / 2, y: world.map.size / 2 });
      }
    } else if (!ctx.mem.attacking) {
      // Rally new units to a forward muster point (toward the nearest enemy) so the next wave gathers
      // near the front. One setRally per building, refreshed only when the point moves > 4 tiles.
      const size = world.map.size;
      let fx = ctx.refX;
      let fy = ctx.refY;
      if (intel.nearestTC >= 0) {
        fx = ctx.refX + (c.posX[intel.nearestTC] - ctx.refX) * STAGING_FRACTION;
        fy = ctx.refY + (c.posY[intel.nearestTC] - ctx.refY) * STAGING_FRACTION;
      }
      const ftx = Math.max(0, Math.min(size - 1, Math.round(fx)));
      const fty = Math.max(0, Math.min(size - 1, Math.round(fy)));
      const moved =
        ctx.mem.rallyTile < 0 ||
        Math.max(Math.abs(tileXOf(size, ctx.mem.rallyTile) - ftx), Math.abs(tileYOf(size, ctx.mem.rallyTile) - fty)) > 4;
      if (moved) {
        for (let b = 0; b < MILITARY_BUILDINGS.length; b++) {
          const list = scan.completeByType[MILITARY_BUILDINGS[b]];
          for (let j = 0; j < list.length; j++) {
            cmds.push({ type: 'setRally', player, building: handleOf(world, list[j]), x: fx, y: fy });
          }
        }
        ctx.mem.rallyTile = tileIndex(size, ftx, fty);
      }
    }
  }

  // --- 2. Military buildings ------------------------------------------------------------------
  let builtCount = 0;
  for (let k = 0; k < BUILDING_ORDER.length && builtCount < MIL_BUILD_CAP; k++) {
    const bt = BUILDING_ORDER[k];
    if (bt === BuildingType.Castle && !ctx.tuning.buildsCastle) continue; // Hard-only castle
    if (bt === BuildingType.Barracks && scan.villagers.length < 7) continue; // Feudal gate ~30s earlier
    if (existingCount(scan, bt) > 0) continue;
    const info = BUILD_INFO[bt];
    if (ps.age < info.age) continue;
    if (info.reqBuilding !== -1 && !hasCompleted(scan, info.reqBuilding)) continue;
    if (!canAffordFree(ctx, info.cost)) continue;
    const near = bt === BuildingType.Castle ? castleTile(ctx) : ctx.ref;
    const cmd = emitBuildHigh(ctx, bt, near);
    if (cmd) {
      cmds.push(cmd);
      builtCount++;
    }
  }
  // Second production building of the preferred class vs the enemy (FEUDAL_ECO+, plenty of wood).
  if (builtCount < MIL_BUILD_CAP && ps.age >= Age.Feudal && ctx.phase !== Phase.DarkOpen && ctx.phase !== Phase.DarkBank) {
    const { shares } = desiredShares(ctx);
    let bi = -1;
    let best = 0;
    for (let i = 0; i < 3; i++) {
      const list = scan.completeByType[MILITARY_BUILDINGS[i]].length + scan.underConstruction[MILITARY_BUILDINGS[i]].length;
      if (list === 1 && shares[i] > best) {
        best = shares[i];
        bi = i;
      }
    }
    if (bi >= 0) {
      const info = BUILD_INFO[MILITARY_BUILDINGS[bi]];
      if (canAffordFree(ctx, info.cost) && ctx.budget[1] - ctx.reserve[1] >= 300) {
        const cmd = emitBuildHigh(ctx, MILITARY_BUILDINGS[bi], ctx.ref);
        if (cmd) {
          cmds.push(cmd);
          builtCount++;
        }
      }
    }
  }
  // Hard-only second Town Center to boom (trained from automatically by econ's TC round-robin).
  if (
    ctx.tuning.buildsCastle &&
    ctx.phase === Phase.Castle &&
    scan.villagers.length >= 20 &&
    existingCount(scan, BuildingType.TownCenter) < 2 &&
    canAffordFree(ctx, BUILD_INFO[BuildingType.TownCenter].cost) &&
    ctx.budget[1] - ctx.reserve[1] >= 350
  ) {
    const gold = findNearestNode(world, ctx.ref, ResourceNode.GoldMine, 40);
    const near = gold >= 0 ? gold : ctx.ref;
    const cmd = emitBuildHigh(ctx, BuildingType.TownCenter, near);
    if (cmd) cmds.push(cmd);
  }

  // --- 3. Composition training (counter-aware; deficit-driven round-robin). --------------------
  const { shares, counterCav } = desiredShares(ctx);
  trainArmy(ctx, cmds, shares, counterCav, threatened);

  // --- 4. Upgrades (relevance-filtered, comfortable surplus). ----------------------------------
  trainUpgrades(ctx, cmds);

  // --- 5. Scout patrol (spectacle + fog reveal; deterministic ring). --------------------------
  if (!threatened && ctx.scout >= 0 && ps.age < Age.Castle) {
    const scoutIdx = ctx.scout;
    const h = handleOf(world, scoutIdx);
    if (h !== ctx.mem.scoutHandle) {
      // New scout: anchor the ring at the waypoint nearest the enemy TC.
      ctx.mem.scoutHandle = h;
      let startK = 0;
      if (intel.nearestTC >= 0) {
        let bd = Infinity;
        for (let k = 0; k < 8; k++) {
          const wp = scoutWaypoint(world, k);
          const d = dist2(c.posX[intel.nearestTC], c.posY[intel.nearestTC], wp.x, wp.y);
          if (d < bd) {
            bd = d;
            startK = k;
          }
        }
      }
      ctx.mem.scoutWaypoint = startK;
      const wp = scoutWaypoint(world, startK);
      cmds.push({ type: 'move', player, units: [h], x: wp.x, y: wp.y });
    } else {
      let wp = scoutWaypoint(world, ctx.mem.scoutWaypoint);
      const near = dist2(c.posX[scoutIdx], c.posY[scoutIdx], wp.x, wp.y) <= 9;
      const idle = c.orderType[scoutIdx] === OrderType.Idle;
      if (near) {
        ctx.mem.scoutWaypoint = (ctx.mem.scoutWaypoint + 1) % 8;
        wp = scoutWaypoint(world, ctx.mem.scoutWaypoint);
        cmds.push({ type: 'move', player, units: [h], x: wp.x, y: wp.y });
      } else if (idle) {
        cmds.push({ type: 'move', player, units: [h], x: wp.x, y: wp.y });
      }
    }
  }

  return cmds;
}

/** A forward-ish tile toward the staging point for the Hard-only Castle. */
function castleTile(ctx: AIContext): number {
  const world = ctx.world;
  const size = world.map.size;
  let tx = Math.round(ctx.refX);
  let ty = Math.round(ctx.refY);
  if (ctx.intel.nearestTC >= 0) {
    tx = Math.round(ctx.refX + (world.comp.posX[ctx.intel.nearestTC] - ctx.refX) * STAGING_FRACTION);
    ty = Math.round(ctx.refY + (world.comp.posY[ctx.intel.nearestTC] - ctx.refY) * STAGING_FRACTION);
  }
  tx = Math.max(0, Math.min(size - 1, tx));
  ty = Math.max(0, Math.min(size - 1, ty));
  return tileIndex(size, tx, ty);
}

/** Deficit-driven, counter-aware training loop shared by normal and defensive (raw-budget) modes. */
function trainArmy(
  ctx: AIContext,
  cmds: Command[],
  shares: number[],
  counterCav: boolean,
  threatened: boolean,
): void {
  const { world, player, scan } = ctx;
  const ps = scan.ps;

  // Gold-poor mass mode: when the treasury can't sustain gold units (militia 20G / archer 45G), fall
  // back to Spearmen (35F/25W, ZERO gold) from the Barracks so a small or gold-starved economy can
  // still mass an army from food+wood instead of stalling at a handful of units. Kept as a FALLBACK
  // (not a late-game default) because Militia out-DPS Spearmen against buildings — while gold lasts
  // the Barracks keeps pumping Militia for faster razing; only when gold dries up do we mass Spears.
  const goldPoor = ps.age >= Age.Feudal && ctx.budget[2] < 45;
  const spearInfantry = counterCav || goldPoor;

  // Candidate building types that exist and can currently produce a valid unit.
  const cand: { bi: number; bt: BuildingType; unit: UnitType }[] = [];
  for (let bi = 0; bi < MILITARY_BUILDINGS.length; bi++) {
    const bt = MILITARY_BUILDINGS[bi];
    if (scan.completeByType[bt].length === 0) continue;
    const unit = unitForBuilding(bt, ps, spearInfantry);
    if (unit === -1) continue;
    const uinfo = UNIT_INFO[unit];
    if (ps.age < uinfo.age) continue;
    if (uinfo.tech !== -1 && ps.researched[uinfo.tech] !== 1) continue;
    cand.push({ bi, bt, unit });
  }
  if (cand.length === 0) return;

  // Own counts by production class (0 inf, 1 arch, 2 cav [minus patrol scout], 3 unique).
  const own = [
    ctx.armyByClass[0],
    ctx.armyByClass[1],
    Math.max(0, ctx.armyByClass[2] - (ctx.scout >= 0 ? 1 : 0)),
    0,
  ];
  const rr = [0, 0, 0, 0]; // round-robin cursor per building type
  const exhausted = new Set<number>();
  let projectedPop = ps.population;
  let trained = 0;
  let guard = 0;
  while (trained < MIL_TRAIN_CAP && guard < MIL_TRAIN_CAP + cand.length + 2) {
    guard++;
    // Dark-Age militia cap (bypassed only under threat).
    if (!threatened && ps.age === Age.Dark && ctx.armyCount + trained >= ctx.tuning.darkMilitia) break;

    // Keep building army up to the per-think cap whenever we can afford it; composition only decides
    // WHICH class to add (the one furthest below its desired share), never WHETHER to build. Starting
    // bestGap at -Infinity means a "balanced" army still keeps growing — otherwise the army stalls at a
    // handful of units and no wave ever masses. Absolute size stays bounded by affordability, the pop
    // cap, queue depth, and (in the Dark Age) the darkMilitia cap above.
    let pick = -1;
    let bestGap = -Infinity;
    for (let k = 0; k < cand.length; k++) {
      const bi = cand[k].bi;
      if (exhausted.has(bi)) continue;
      const gap = shares[bi] * (ctx.armyCount + 1) - own[bi];
      if (gap > bestGap) {
        bestGap = gap;
        pick = k;
      }
    }
    if (pick < 0) break;
    const cbt = cand[pick];
    const uinfo = UNIT_INFO[cbt.unit];
    if (projectedPop + uinfo.pop > ps.populationCap) break; // pop full -> stop entirely
    const affordOk = threatened ? canAffordBudget(ctx.budget, uinfo.cost) : canAffordFree(ctx, uinfo.cost);
    if (!affordOk) {
      exhausted.add(cbt.bi);
      continue;
    }
    // Round-robin a building of this type with queue room.
    const buildings = scan.completeByType[cbt.bt];
    let bldg = -1;
    for (let n = 0; n < buildings.length; n++) {
      const b = buildings[(rr[cbt.bi] + n) % buildings.length];
      if (queueLen(world, b) < MIL_QUEUE_MAX) {
        bldg = b;
        rr[cbt.bi] = (rr[cbt.bi] + n + 1) % buildings.length;
        break;
      }
    }
    if (bldg < 0) {
      exhausted.add(cbt.bi);
      continue;
    }
    cmds.push({ type: 'train', player, building: handleOf(world, bldg), unit: cbt.unit });
    spend(ctx.budget, uinfo.cost);
    projectedPop += uinfo.pop;
    own[cbt.bi]++;
    trained++;
  }
}

/** Blacksmith/eco upgrades, filtered to relevance; one per think with a comfortable surplus. */
function trainUpgrades(ctx: AIContext, cmds: Command[]): void {
  const { world, player, scan } = ctx;
  const ps = scan.ps;
  const total = ctx.armyCount;
  const archerShare = total > 0 ? ctx.armyByClass[1] / total : 0;
  const cavShare = total > 0 ? Math.max(0, ctx.armyByClass[2] - (ctx.scout >= 0 ? 1 : 0)) / total : 0;

  let techCount = 0;
  for (let k = 0; k < UPGRADE_ORDER.length && techCount < MIL_TECH_CAP; k++) {
    const tech = UPGRADE_ORDER[k];
    // Relevance filters: don't sink resources into upgrades for units we don't field.
    if ((tech === TechId.Fletching || tech === TechId.BodkinArrow) && archerShare < 0.15) continue;
    if (tech === TechId.ScaleBardingArmor && cavShare < 0.15) continue;
    if (!techReqsMet(ps, scan, tech)) continue;
    const info = TECH_INFO[tech];
    if (!canAffordFree(ctx, info.cost, ctx.tuning.upgradeMult)) continue;
    const bldg = scan.completeByType[info.at][0];
    if (bldg === undefined) continue;
    if (queueLen(world, bldg) >= MIL_QUEUE_MAX || queueHasTech(world, bldg, tech)) continue;
    cmds.push({ type: 'research', player, building: handleOf(world, bldg), tech });
    spend(ctx.budget, info.cost);
    techCount++;
  }
}
