/** Grid position in tile coordinates */
export interface TilePos {
  col: number;
  row: number;
}

/** World position in pixels */
export interface WorldPos {
  x: number;
  y: number;
}

export type TowerId = string;
export type EnemyId = string;

export type TowerKind = "arrow" | "cannon" | "frost" | "lightning" | "mortar";
export type EnemyKind = "basic" | "fast" | "armored" | "flying" | "boss";

export type GameMode = "solo" | "coop" | "versus";

export interface TowerConfig {
  kind: TowerKind;
  name: string;
  cost: number;
  damage: number;
  range: number; // in tiles
  fireRate: number; // shots per second
  splash: number; // splash radius in tiles, 0 = single target
  special: string | null;
  upgrades: TowerUpgrade[];
}

export interface TowerUpgrade {
  tier: 1 | 2 | 3;
  cost: number;
  damageMultiplier: number;
  rangeMultiplier: number;
  fireRateMultiplier: number;
  /** Tier 3 specialization name, null for tiers 1-2 */
  specialization: string | null;
}

export interface EnemyConfig {
  kind: EnemyKind;
  name: string;
  hp: number;
  speed: number; // tiles per second
  reward: number; // gold on kill
  armor: number; // flat damage reduction
  flying: boolean;
  waveBudgetCost: number;
}

export interface WaveConfig {
  waveNumber: number;
  budget: number;
  prepTimeSec: number;
  isBoss: boolean;
  bossKind?: EnemyKind;
}

export type TileType = "path" | "buildable" | "blocked" | "start" | "end";

export interface MapTile {
  type: TileType;
}

export interface GameMap {
  name: string;
  cols: number;
  rows: number;
  tileSize: number;
  tiles: TileType[][];
  /** Ordered waypoints the path follows (tile coords) */
  path: TilePos[];
}

export interface TowerState {
  id: TowerId;
  kind: TowerKind;
  pos: TilePos;
  tier: number;
  targetId: EnemyId | null;
  cooldownRemaining: number;
}

export interface EnemyState {
  id: EnemyId;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  /** Index into the map's path array + fractional progress */
  pathIndex: number;
  worldPos: WorldPos;
  speed: number;
  armor: number;
  flying: boolean;
  slowFactor: number;
  slowDuration: number;
}

export interface ProjectileState {
  id: string;
  fromTower: TowerId;
  targetEnemy: EnemyId;
  worldPos: WorldPos;
  damage: number;
  splash: number;
  speed: number;
}

export interface GameState {
  mode: GameMode;
  wave: number;
  phase: "prep" | "combat" | "gameover" | "victory";
  prepTimeRemaining: number;
  gold: number;
  lives: number;
  maxLives: number;
  towers: Map<TowerId, TowerState>;
  enemies: Map<EnemyId, EnemyState>;
  projectiles: ProjectileState[];
  score: number;
}

/** Summary of the opponent's state shown in versus mode */
export interface VersusOpponentSummary {
  playerId: string;
  name: string;
  lives: number;
  maxLives: number;
  gold: number;
  attackTokens: number;
  towerCount: number;
}
