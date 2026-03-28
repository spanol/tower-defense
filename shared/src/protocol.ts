/**
 * Network protocol definitions for multiplayer tower defense.
 * JSON for lobby/chat, binary (msgpack) for game state.
 */

import type {
  TowerKind,
  EnemyKind,
  TilePos,
  WorldPos,
  GameMode,
  VersusOpponentSummary,
} from "./types.js";

// ── Player / Room ──────────────────────────────────────

export type PlayerId = string;
export type RoomId = string;

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  ready: boolean;
  /** Color index for multiplayer visuals */
  colorIndex: number;
}

export type RoomStatus = "waiting" | "starting" | "playing" | "finished";

export interface RoomInfo {
  id: RoomId;
  code: string; // 4-char join code
  hostId: PlayerId;
  mode: GameMode;
  mapKey: string;
  maxPlayers: number;
  players: PlayerInfo[];
  status: RoomStatus;
}

// ── Client → Server messages ───────────────────────────

export type ClientMessage =
  | ClientCreateRoom
  | ClientJoinRoom
  | ClientLeaveRoom
  | ClientSetReady
  | ClientStartGame
  | ClientPlaceTower
  | ClientUpgradeTower
  | ClientSellTower
  | ClientSendAttack
  | ClientChat
  | ClientPing;

export interface ClientCreateRoom {
  type: "create_room";
  playerName: string;
  mode: GameMode;
  mapKey: string;
}

export interface ClientJoinRoom {
  type: "join_room";
  playerName: string;
  roomCode: string;
}

export interface ClientLeaveRoom {
  type: "leave_room";
}

export interface ClientSetReady {
  type: "set_ready";
  ready: boolean;
}

export interface ClientStartGame {
  type: "start_game";
}

export interface ClientPlaceTower {
  type: "place_tower";
  kind: TowerKind;
  pos: TilePos;
  seq: number; // client prediction sequence
}

export interface ClientUpgradeTower {
  type: "upgrade_tower";
  towerId: string;
  seq: number;
}

export interface ClientSellTower {
  type: "sell_tower";
  towerId: string;
  seq: number;
}

export interface ClientSendAttack {
  type: "send_attack";
  /** Number of attack tokens to spend */
  tokens: number;
}

export interface ClientChat {
  type: "chat";
  text: string;
}

export interface ClientPing {
  type: "ping";
  t: number; // client timestamp
}

// ── Server → Client messages ───────────────────────────

export type ServerMessage =
  | ServerRoomCreated
  | ServerRoomJoined
  | ServerRoomUpdated
  | ServerRoomLeft
  | ServerGameStarting
  | ServerGameState
  | ServerGameDelta
  | ServerActionAck
  | ServerActionReject
  | ServerWaveStart
  | ServerWaveComplete
  | ServerGameOver
  | ServerVictory
  | ServerVersusResult
  | ServerAttackIncoming
  | ServerChat
  | ServerPong
  | ServerError;

export interface ServerRoomCreated {
  type: "room_created";
  room: RoomInfo;
}

export interface ServerRoomJoined {
  type: "room_joined";
  room: RoomInfo;
  playerId: PlayerId;
}

export interface ServerRoomUpdated {
  type: "room_updated";
  room: RoomInfo;
}

export interface ServerRoomLeft {
  type: "room_left";
}

export interface ServerGameStarting {
  type: "game_starting";
  countdown: number; // seconds
}

export interface ServerActionAck {
  type: "action_ack";
  seq: number;
  towerId?: string; // for place_tower, the server-assigned id
}

export interface ServerActionReject {
  type: "action_reject";
  seq: number;
  reason: string;
}

export interface ServerChat {
  type: "chat";
  playerId: PlayerId;
  playerName: string;
  text: string;
}

export interface ServerPong {
  type: "pong";
  t: number; // echoed client timestamp
  serverTime: number;
}

export interface ServerError {
  type: "error";
  message: string;
}

// ── Game state snapshots (sent as binary via msgpack) ──

export interface NetTower {
  id: string;
  kind: TowerKind;
  pos: TilePos;
  tier: number;
  ownerId: PlayerId;
}

export interface NetEnemy {
  id: string;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  pathIndex: number;
  worldPos: WorldPos;
  slowFactor: number;
  slowDuration: number;
}

export interface NetProjectile {
  id: string;
  towerKind: TowerKind;
  targetId: string;
  worldPos: WorldPos;
  damage: number;
  splash: number;
}

/** Full game state snapshot — sent on join and periodically */
export interface ServerGameState {
  type: "game_state";
  tick: number;
  wave: number;
  phase: "prep" | "combat" | "gameover" | "victory";
  prepTimeRemaining: number;
  gold: number; // shared in co-op, per-player in versus
  lives: number;
  maxLives: number;
  towers: NetTower[];
  enemies: NetEnemy[];
  projectiles: NetProjectile[];
  score: number;
  players: PlayerInfo[];
  /** Versus-only: current player's attack tokens */
  attackTokens?: number;
  /** Versus-only: opponent summary */
  opponent?: VersusOpponentSummary;
}

/** Delta update — only changed fields (sent at 20 ticks/sec) */
export interface ServerGameDelta {
  type: "game_delta";
  tick: number;
  wave?: number;
  phase?: "prep" | "combat" | "gameover" | "victory";
  prepTimeRemaining?: number;
  gold?: number;
  lives?: number;
  score?: number;
  /** Towers added or updated this tick */
  towersUpsert?: NetTower[];
  /** Tower IDs removed this tick */
  towersRemove?: string[];
  /** Enemies added or updated this tick */
  enemiesUpsert?: NetEnemy[];
  /** Enemy IDs removed this tick */
  enemiesRemove?: string[];
  /** Projectiles — full replacement each delta (small set) */
  projectiles?: NetProjectile[];
  /** Versus-only: current player's attack tokens */
  attackTokens?: number;
  /** Versus-only: opponent summary */
  opponent?: VersusOpponentSummary;
}

export interface ServerWaveStart {
  type: "wave_start";
  wave: number;
  enemyCount: number;
}

export interface ServerWaveComplete {
  type: "wave_complete";
  wave: number;
  goldBonus: number;
  interestGold: number;
}

export interface ServerGameOver {
  type: "game_over";
  wave: number;
  score: number;
}

export interface ServerVictory {
  type: "victory";
  wave: number;
  score: number;
}

export interface ServerVersusResult {
  type: "versus_result";
  winner: PlayerId;
  winnerName: string;
  loser: PlayerId;
  loserName: string;
  wave: number;
}

export interface ServerAttackIncoming {
  type: "attack_incoming";
  fromPlayer: PlayerId;
  enemyCount: number;
}

// ── Constants ──────────────────────────────────────────

export const TICK_RATE = 20; // server ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const FULL_STATE_INTERVAL = 100; // full snapshot every N ticks (5 sec)
export const RECONNECT_GRACE_MS = 30_000;
export const MAX_ROOM_PLAYERS = 4;
export const MAX_VERSUS_PLAYERS = 2;
export const ROOM_CODE_LENGTH = 4;
