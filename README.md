# AoE Mini — an Age of Empires II–style RTS (minimum working version)

A browser real-time-strategy game in the spirit of *Age of Empires II*, built in **TypeScript** with a
deterministic, render-independent simulation core and a Canvas2D isometric renderer. Three
civilizations, four ages, economy → military → conquest.

## Quick start

```bash
npm install
npm run dev        # open the printed http://localhost:5173  (add ?seed=1234 to pick a map)
```

You play **Britons** (blue) vs **AI Franks** (red) and **AI Mongols** (green).

Other scripts:

```bash
npm run build      # type-check + production bundle to dist/
npm test           # full Vitest suite (194 tests)
npm run headless   # deterministic AI-vs-AI match (no browser) — the integration merge gate
```

## Controls

- **Left-drag** box-select your units · **left-click** select · **shift-click** add to selection
- **Right-click**: contextual order — move, attack (enemy), gather (resource / sheep / farm), or set a building's rally point
- **Build**: select villagers → click a build button in the HUD → click a tile (Esc cancels)
- **Train / research**: select a building → use its HUD buttons
- **Camera**: WASD / arrow keys / screen-edge pan · mouse wheel zoom · **H** jumps to your Town Center
- Control groups: **Ctrl+1..9** to set, **1..9** to recall

## What's in the slice

- **4 resources** (food/wood/gold/stone); villagers gather from forage, sheep, farms, trees, gold & stone mines with drop-off buildings, and construct buildings
- **11 building types** (Town Center, House, Mill, Lumber/Mining Camp, Farm, Barracks, Archery Range, Stable, Blacksmith, Castle); population cap via Houses + TC (max 200)
- **Units**: Villager, Militia→Man-at-Arms, Spearman (anti-cavalry), Archer, Scout Cavalry, Knight, plus each civ's unique Castle unit
- **4 Ages** (Dark/Feudal/Castle/Imperial) gated by resource cost + building prerequisites; Blacksmith and unit-line upgrades
- **Combat** with HP, melee/pierce armor, bonus damage vs classes, and homing projectiles for ranged units
- **Fog of war** + per-unit line of sight + exploration; **minimap**; resource/pop/age HUD; production queues
- **3 civilizations** with distinct data-driven bonuses:
  - **Britons** — foot archers +1 range, Town Centers −50% wood, shepherds +25%; unique **Longbowman**
  - **Franks** — Knights +20% HP, foragers +25%, Castles −25% cost; unique **Throwing Axeman**
  - **Mongols** — Scout line +30% HP, Mangudai fire faster, cavalry-archer focus; unique **Mangudai**
- **AI opponents** (economy → build order → army → attack waves) and **conquest victory**

## Architecture

Strict layering; the simulation never imports rendering or the DOM.

```
src/shared/   Frozen contracts: constants, enums, World/components (SoA), Command & event unions,
              content types, Renderer/Input interfaces, isometric math, seeded PRNG.
src/core/     Deterministic kernel: entity manager (free-list + generations), Structure-of-Arrays
              component stores, spatial hash grid, FNV-1a world checksum.
src/map/      Tile map, seeded map generator, A* pathfinding (+ version-gated path cache), fog/LOS.
src/content/  Data tables (units/buildings/techs/civs) + stat/cost/prereq resolver (civ bonuses,
              researched-tech modifiers).
src/sim/      createWorld, command validation/application, movement, death, victory, the fixed-order
              tick pipeline (createStepper + step-default), headless match runner.
src/systems/  Behavior systems: villager work, production/research, combat, projectiles.
src/ai/       Heuristic AI opponents — pure Command emitters with a private seeded RNG.
src/render/   Canvas2D isometric renderer (procedural sprites, chunk-cached terrain, fog, minimap).
src/ui/,app/  Input controller, screen↔world picking, DOM HUD, fixed-timestep rAF loop, bootstrap.
```

**Why this shape.** The sim is a fixed-timestep (20 Hz), seeded, command-driven, Structure-of-Arrays
ECS with spatial-hash neighbor queries — so it is *fast* (linear typed-array hot loops, no per-tick
allocation, cached A*), *deterministic* (same seed + command log → identical world checksum every
tick — replay- and lockstep-netcode-ready), *testable* (headless in Node with zero DOM coupling; a
static scan bans `Math.random`/`Date`/DOM in sim code), and *maintainable* (content is data rows +
enum ids via a generic Modifier system; the renderer sits behind a `Renderer` interface a WebGL
backend can replace).

## Tests

194 Vitest tests: per-module units (PRNG goldens, entity/generation semantics, spatial-query
exactness, A* + re-path, content stat resolution, command validation, gather/build/combat), a
determinism suite (checksum-equal reruns + a source static-scan), browser-layer tests (picking
round-trips the shared iso math, synthetic input → Commands, loop tick-accounting), and the
headless AI-vs-AI **merge gate** that plays a full 3-player match to a decisive, reproducible winner.
