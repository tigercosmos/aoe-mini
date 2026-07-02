import type { BuildingType, PlayerId, TechId, UnitType } from './enums';

export type Command =
  | { type: 'stop';        player: PlayerId; units: number[] }
  | { type: 'move';        player: PlayerId; units: number[]; x: number; y: number }
  | { type: 'attackMove';  player: PlayerId; units: number[]; x: number; y: number }
  | { type: 'attack';      player: PlayerId; units: number[]; target: number }
  | { type: 'gatherTile';  player: PlayerId; units: number[]; tile: number }      // Tree/Forage/GoldMine/StoneMine tile
  | { type: 'gatherEntity';player: PlayerId; units: number[]; target: number }    // Sheep or completed Farm
  | { type: 'build';       player: PlayerId; units: number[]; building: BuildingType; tileX: number; tileY: number }
  | { type: 'train';       player: PlayerId; building: number; unit: UnitType }
  | { type: 'research';    player: PlayerId; building: number; tech: TechId }
  | { type: 'cancelProduction'; player: PlayerId; building: number; queueIndex: number }
  | { type: 'setRally';    player: PlayerId; building: number; x: number; y: number };

export type CommandType = Command['type'];
export type CommandSink = (cmd: Command) => void;
