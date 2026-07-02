import type { Age, BuildingType, EntityKind, PlayerId, ProjectileType, TechId } from './enums';
import type { Command } from './commands';

export type GameEvent =
  | { type: 'spawned';  entity: number; owner: PlayerId; kind: EntityKind; subtype: number; x: number; y: number }
  | { type: 'died';     entity: number; owner: PlayerId; kind: EntityKind; subtype: number; x: number; y: number; killer: PlayerId }
  | { type: 'commandRejected'; player: PlayerId; command: Command; reason: string }
  | { type: 'constructionComplete'; entity: number; owner: PlayerId; building: BuildingType }
  | { type: 'researchComplete'; player: PlayerId; tech: TechId }
  | { type: 'ageAdvanced'; player: PlayerId; age: Age }
  | { type: 'projectileFired'; from: number; to: number; projectile: ProjectileType }
  | { type: 'resourceNodeDepleted'; tile: number }
  | { type: 'playerDefeated'; player: PlayerId }
  | { type: 'matchEnded'; winner: PlayerId };
