// T4 sim engine — the REAL tick wiring.
// This is the ONLY file that imports src/systems (T5) and src/map/visibility (T2). Everything
// else that needs to step the world imports `stepWorld` from here.
import type { Command } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import type { World } from '../shared/world';
import { createStepper } from './tick';
import { productionSystem } from '../systems/production';
import { villagerSystem } from '../systems/villager';
import { combatSystem } from '../systems/combat';
import { projectileSystem } from '../systems/projectile';
import { updateVisibility } from '../map/visibility';

/** The fully-wired tick function used by the browser loop and the headless runner. */
export const stepWorld: (world: World, commands: Command[]) => GameEvent[] = createStepper(
  {
    production: productionSystem,
    villager: villagerSystem,
    combat: combatSystem,
    projectile: projectileSystem,
  },
  updateVisibility,
);
