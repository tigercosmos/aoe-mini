// T4 sim engine — tick orchestration.
// tick.ts is dependency-injected: it imports NO behavior systems (src/systems) and NO
// visibility (src/map/visibility). Real wiring lives in src/sim/step-default.ts.
import { VISIBILITY_INTERVAL } from '../shared/constants';
import type { Command } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import type { System, SystemSet } from '../shared/interfaces';
import type { World } from '../shared/world';
import { applyCommands } from './commands';
import { movementSystem } from './movement';
import { deathSystem } from './death';
import { victorySystem } from './victory';

/** Documented per-tick pipeline order (determinismAndLoop). */
export const SYSTEM_ORDER: readonly string[] = [
  'applyCommands',
  'production',
  'villager',
  'movement',
  'combat',
  'projectile',
  'death',
  'visibility',
  'victory',
];

/**
 * Build a tick stepper from injected behavior systems. The four T5 systems come via
 * `systems`; movement/death/victory are T4's own; fog `updateVisibility` is injected (default
 * no-op) so tick.ts never imports T2 — step-default.ts passes the real function. Visibility is
 * render-only (it never affects sim state or the checksum), so a no-op is fine for unit tests.
 */
export function createStepper(
  systems: SystemSet,
  updateVisibility: System = () => {},
): (world: World, commands: Command[]) => GameEvent[] {
  return function step(world: World, commands: Command[]): GameEvent[] {
    world.events.length = 0;
    world.tick++;

    world.comp.prevX.set(world.comp.posX);
    world.comp.prevY.set(world.comp.posY);

    applyCommands(world, commands);
    systems.production(world);
    systems.villager(world);
    movementSystem(world);
    systems.combat(world);
    systems.projectile(world);
    deathSystem(world);
    if (world.tick % VISIBILITY_INTERVAL === 0) updateVisibility(world);
    victorySystem(world);

    return world.events;
  };
}
