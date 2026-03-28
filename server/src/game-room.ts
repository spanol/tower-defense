/**
 * GameRoom — authoritative game simulation for a multiplayer room.
 * Manages game state, processes player commands, runs the tick loop,
 * and broadcasts deltas to connected players.
 *
 * Supports two modes:
 *   - coop: shared gold/lives/towers, all players on one map
 *   - versus: per-player lanes with independent economies and attack tokens
 */

import { v4 as uuid } from "uuid";
import { encode } from "@msgpack/msgpack";
import {
  MAPS,
  TOWER_CONFIGS,
  ENEMY_CONFIGS,
  type GameMap,
  type TilePos,
  type WorldPos,
  type TowerKind,
  type EnemyKind,
  type TowerConfig,
  type GameMode,
  type VersusOpponentSummary,
} from "@td/shared";
import type {
  PlayerId,
  RoomId,
  PlayerInfo,
  RoomInfo,
  RoomStatus,
  ServerMessage,
  ServerGameState,
  ServerGameDelta,
  NetTower,
  NetEnemy,
  NetProjectile,
  ClientPlaceTower,
  ClientUpgradeTower,
  ClientSellTower,
  ClientSendAttack,
} from "@td/shared";
import {
  TICK_RATE,
  TICK_MS,
  FULL_STATE_INTERVAL,
  RECONNECT_GRACE_MS,
  MAX_ROOM_PLAYERS,
  MAX_VERSUS_PLAYERS,
  ROOM_CODE_LENGTH,
} from "@td/shared";

// ── Economy constants ──────────────────────────────────
const INTEREST_RATE = 0.05;
const INTEREST_CAP = 500;
const STARTING_GOLD = 200;
const STARTING_LIVES = 20;
const MAX_WAVES = 25;
const SELL_REFUND = 0.6;

// ── Versus constants ───────────────────────────────────
/** Tokens earned per wave survived */
const TOKENS_PER_WAVE = 1;
/** Bonus token for clearing a wave with no leaks */
const TOKENS_CLEAN_BONUS = 1;
/** Number of enemies spawned per token spent */
const ENEMIES_PER_TOKEN = 2;

// ── Helpers ────────────────────────────────────────────

function tileCenterX(col: number, tileSize: number): number {
  return col * tileSize + tileSize / 2;
}
function tileCenterY(row: number, tileSize: number): number {
  return row * tileSize + tileSize / 2;
}
function dist(a: WorldPos, b: WorldPos): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function effectiveStats(config: TowerConfig, tier: number) {
  let damage = config.damage;
  let range = config.range;
  let fireRate = config.fireRate;
  for (let t = 0; t < tier && t < config.upgrades.length; t++) {
    const u = config.upgrades[t];
    damage *= u.damageMultiplier;
    range *= u.rangeMultiplier;
    fireRate *= u.fireRateMultiplier;
  }
  return { damage: Math.round(damage), range, fireRate, splash: config.splash };
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateWave(waveNum: number): { kind: EnemyKind; delay: number }[] {
  const budget = 50 + waveNum * 35;
  const isBoss = waveNum % 5 === 0;
  const enemies: { kind: EnemyKind; delay: number }[] = [];

  if (isBoss) {
    enemies.push({ kind: "boss", delay: 0 });
    const escortBudget = budget - ENEMY_CONFIGS.boss.waveBudgetCost;
    let remaining = escortBudget;
    let idx = 1;
    while (remaining >= ENEMY_CONFIGS.armored.waveBudgetCost) {
      enemies.push({ kind: "armored", delay: idx * 600 });
      remaining -= ENEMY_CONFIGS.armored.waveBudgetCost;
      idx++;
    }
    return enemies;
  }

  let remaining = budget;
  let idx = 0;
  const kinds: EnemyKind[] = ["basic", "fast"];
  if (waveNum >= 3) kinds.push("armored");
  if (waveNum >= 5) kinds.push("flying");

  while (remaining > 0) {
    const kind = kinds[idx % kinds.length];
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg || cfg.waveBudgetCost > remaining) break;
    remaining -= cfg.waveBudgetCost;
    enemies.push({ kind, delay: idx * 500 });
    idx++;
  }
  return enemies;
}

/** Generate attack enemies sent to opponent */
function generateAttackEnemies(
  count: number,
  waveNum: number,
): { kind: EnemyKind; delay: number }[] {
  const enemies: { kind: EnemyKind; delay: number }[] = [];
  const kinds: EnemyKind[] = ["basic", "fast"];
  if (waveNum >= 3) kinds.push("armored");
  for (let i = 0; i < count; i++) {
    enemies.push({ kind: kinds[i % kinds.length], delay: i * 400 });
  }
  return enemies;
}

// ── Internal entity types ──────────────────────────────

interface ServerTower {
  id: string;
  kind: TowerKind;
  config: TowerConfig;
  pos: TilePos;
  tier: number;
  cooldown: number;
  ownerId: PlayerId;
  dirty: boolean;
}

interface ServerEnemy {
  id: string;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  speed: number;
  armor: number;
  flying: boolean;
  reward: number;
  pathIndex: number;
  worldPos: WorldPos;
  slowFactor: number;
  slowDuration: number;
  dirty: boolean;
}

interface ServerProjectile {
  id: string;
  towerKind: TowerKind;
  damage: number;
  splash: number;
  speed: number;
  targetId: string;
  worldPos: WorldPos;
  chainCount: number;
  chainHitIds: Set<string>;
}

interface DisconnectedPlayer {
  info: PlayerInfo;
  disconnectedAt: number;
}

/** Per-player game lane used in versus mode */
interface VersusLane {
  playerId: PlayerId;
  gold: number;
  lives: number;
  maxLives: number;
  score: number;
  attackTokens: number;
  towers: Map<string, ServerTower>;
  enemies: Map<string, ServerEnemy>;
  projectiles: ServerProjectile[];
  waveSpawns: { kind: EnemyKind; delay: number }[];
  waveSpawnIndex: number;
  waveSpawnTimer: number;
  /** Pending attack enemies queued from opponent */
  attackQueue: { kind: EnemyKind; delay: number }[];
  attackSpawnIndex: number;
  attackSpawnTimer: number;
  /** Whether this player leaked enemies this wave */
  leaked: boolean;
  /** Whether this player's wave spawning + enemies are done */
  waveComplete: boolean;
  // Delta tracking
  towersUpserted: Set<string>;
  towersRemoved: Set<string>;
  enemiesUpserted: Set<string>;
  enemiesRemoved: Set<string>;
  dirtyScalars: boolean;
}

export type SendFn = (playerId: PlayerId, msg: ServerMessage | Uint8Array) => void;

// ── GameRoom ───────────────────────────────────────────

export class GameRoom {
  readonly id: RoomId;
  readonly code: string;
  readonly mode: GameMode;
  readonly mapKey: string;
  readonly map: GameMap;

  private hostId: PlayerId;
  private players = new Map<PlayerId, PlayerInfo>();
  private disconnected = new Map<PlayerId, DisconnectedPlayer>();
  private status: RoomStatus = "waiting";

  // Shared game state (used in coop mode)
  private tick = 0;
  private wave = 0;
  private phase: "prep" | "combat" | "gameover" | "victory" = "prep";
  private prepTimeRemaining = 5;
  private gold = STARTING_GOLD;
  private lives = STARTING_LIVES;
  private maxLives = STARTING_LIVES;
  private score = 0;

  private towers = new Map<string, ServerTower>();
  private enemies = new Map<string, ServerEnemy>();
  private projectiles: ServerProjectile[] = [];

  private waveSpawns: { kind: EnemyKind; delay: number }[] = [];
  private waveSpawnIndex = 0;
  private waveSpawnTimer = 0;

  // Delta tracking (coop)
  private towersUpserted = new Set<string>();
  private towersRemoved = new Set<string>();
  private enemiesUpserted = new Set<string>();
  private enemiesRemoved = new Set<string>();
  private dirtyScalars = false;

  // Versus-mode per-player lanes
  private lanes = new Map<PlayerId, VersusLane>();

  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private sendFn: SendFn;

  private nextEntityId = 0;

  constructor(
    hostId: PlayerId,
    hostName: string,
    mode: GameMode,
    mapKey: string,
    sendFn: SendFn,
  ) {
    this.id = uuid();
    this.code = generateRoomCode();
    this.mode = mode;
    this.mapKey = mapKey;
    this.map = MAPS[mapKey] ?? MAPS.forest;
    this.hostId = hostId;
    this.sendFn = sendFn;

    this.addPlayer(hostId, hostName);
  }

  private uid(): string {
    return `e${++this.nextEntityId}`;
  }

  // ── Player management ──────────────────────────────

  addPlayer(id: PlayerId, name: string): boolean {
    const maxP = this.mode === "versus" ? MAX_VERSUS_PLAYERS : MAX_ROOM_PLAYERS;
    if (this.players.size >= maxP) return false;
    if (this.status !== "waiting") {
      // Allow reconnection during game
      const disc = this.disconnected.get(id);
      if (disc) {
        this.disconnected.delete(id);
        this.players.set(id, disc.info);
        return true;
      }
      return false;
    }

    const colorIndex = this.players.size;
    this.players.set(id, { id, name, ready: false, colorIndex });
    return true;
  }

  removePlayer(id: PlayerId): boolean {
    const player = this.players.get(id);
    if (!player) return false;

    if (this.status === "playing") {
      // Grace period for reconnection
      this.disconnected.set(id, {
        info: player,
        disconnectedAt: Date.now(),
      });
    }
    this.players.delete(id);

    // Transfer host if needed
    if (id === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value!;
    }

    return this.players.size === 0;
  }

  setReady(id: PlayerId, ready: boolean): void {
    const player = this.players.get(id);
    if (player) player.ready = ready;
  }

  isHost(id: PlayerId): boolean {
    return id === this.hostId;
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getStatus(): RoomStatus {
    return this.status;
  }

  getRoomInfo(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      mapKey: this.mapKey,
      maxPlayers: this.mode === "versus" ? MAX_VERSUS_PLAYERS : MAX_ROOM_PLAYERS,
      players: Array.from(this.players.values()),
      status: this.status,
    };
  }

  // ── Game lifecycle ─────────────────────────────────

  canStart(requesterId: PlayerId): boolean {
    if (requesterId !== this.hostId) return false;
    if (this.status !== "waiting") return false;
    for (const player of this.players.values()) {
      if (player.id !== this.hostId && !player.ready) return false;
    }
    if (this.mode === "versus" && this.players.size !== 2) return false;
    return this.players.size >= 1;
  }

  startGame(): void {
    this.status = "playing";
    this.tick = 0;
    this.wave = 0;
    this.phase = "prep";
    this.prepTimeRemaining = 3;
    this.nextEntityId = 0;

    if (this.mode === "versus") {
      this.initVersusLanes();
    } else {
      this.gold = STARTING_GOLD;
      this.lives = STARTING_LIVES;
      this.maxLives = STARTING_LIVES;
      this.score = 0;
      this.towers.clear();
      this.enemies.clear();
      this.projectiles = [];
    }

    this.startNextWave();

    // Start tick loop
    this.tickInterval = setInterval(() => this.doTick(), TICK_MS);

    // Broadcast initial full state
    this.broadcastFullState();
  }

  private initVersusLanes(): void {
    this.lanes.clear();
    for (const player of this.players.values()) {
      this.lanes.set(player.id, {
        playerId: player.id,
        gold: STARTING_GOLD,
        lives: STARTING_LIVES,
        maxLives: STARTING_LIVES,
        score: 0,
        attackTokens: 0,
        towers: new Map(),
        enemies: new Map(),
        projectiles: [],
        waveSpawns: [],
        waveSpawnIndex: 0,
        waveSpawnTimer: 0,
        attackQueue: [],
        attackSpawnIndex: 0,
        attackSpawnTimer: 0,
        leaked: false,
        waveComplete: false,
        towersUpserted: new Set(),
        towersRemoved: new Set(),
        enemiesUpserted: new Set(),
        enemiesRemoved: new Set(),
        dirtyScalars: false,
      });
    }
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.status = "finished";
  }

  // ── Cleanup disconnected players past grace period ─

  cleanupDisconnected(): boolean {
    const now = Date.now();
    for (const [id, disc] of this.disconnected) {
      if (now - disc.disconnectedAt > RECONNECT_GRACE_MS) {
        this.disconnected.delete(id);
      }
    }
    return this.players.size === 0 && this.disconnected.size === 0;
  }

  // ── Command handlers ───────────────────────────────

  handlePlaceTower(playerId: PlayerId, cmd: ClientPlaceTower): void {
    const { kind, pos, seq } = cmd;
    const cfg = TOWER_CONFIGS[kind];
    if (!cfg) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Invalid tower kind" });
      return;
    }

    if (pos.row < 0 || pos.row >= this.map.rows || pos.col < 0 || pos.col >= this.map.cols) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Out of bounds" });
      return;
    }
    if (this.map.tiles[pos.row][pos.col] !== "buildable") {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Not buildable" });
      return;
    }

    if (this.mode === "versus") {
      this.versusPlaceTower(playerId, cmd, cfg);
    } else {
      this.coopPlaceTower(playerId, cmd, cfg);
    }
  }

  private coopPlaceTower(playerId: PlayerId, cmd: ClientPlaceTower, cfg: TowerConfig): void {
    const { kind, pos, seq } = cmd;
    for (const t of this.towers.values()) {
      if (t.pos.col === pos.col && t.pos.row === pos.row) {
        this.sendFn(playerId, { type: "action_reject", seq, reason: "Tile occupied" });
        return;
      }
    }
    if (this.gold < cfg.cost) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Not enough gold" });
      return;
    }

    this.gold -= cfg.cost;
    this.dirtyScalars = true;

    const towerId = this.uid();
    const tower: ServerTower = {
      id: towerId, kind, config: cfg, pos, tier: 0,
      cooldown: 0, ownerId: playerId, dirty: true,
    };
    this.towers.set(towerId, tower);
    this.towersUpserted.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq, towerId });
  }

  private versusPlaceTower(playerId: PlayerId, cmd: ClientPlaceTower, cfg: TowerConfig): void {
    const { kind, pos, seq } = cmd;
    const lane = this.lanes.get(playerId);
    if (!lane) return;

    for (const t of lane.towers.values()) {
      if (t.pos.col === pos.col && t.pos.row === pos.row) {
        this.sendFn(playerId, { type: "action_reject", seq, reason: "Tile occupied" });
        return;
      }
    }
    if (lane.gold < cfg.cost) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Not enough gold" });
      return;
    }

    lane.gold -= cfg.cost;
    lane.dirtyScalars = true;

    const towerId = this.uid();
    const tower: ServerTower = {
      id: towerId, kind, config: cfg, pos, tier: 0,
      cooldown: 0, ownerId: playerId, dirty: true,
    };
    lane.towers.set(towerId, tower);
    lane.towersUpserted.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq, towerId });
  }

  handleUpgradeTower(playerId: PlayerId, cmd: ClientUpgradeTower): void {
    if (this.mode === "versus") {
      this.versusUpgradeTower(playerId, cmd);
    } else {
      this.coopUpgradeTower(playerId, cmd);
    }
  }

  private coopUpgradeTower(playerId: PlayerId, cmd: ClientUpgradeTower): void {
    const { towerId, seq } = cmd;
    const tower = this.towers.get(towerId);
    if (!tower) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Tower not found" });
      return;
    }
    if (tower.tier >= 3) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Max tier" });
      return;
    }
    const upgrade = tower.config.upgrades[tower.tier];
    if (this.gold < upgrade.cost) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Not enough gold" });
      return;
    }

    this.gold -= upgrade.cost;
    tower.tier++;
    tower.dirty = true;
    this.dirtyScalars = true;
    this.towersUpserted.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq });
  }

  private versusUpgradeTower(playerId: PlayerId, cmd: ClientUpgradeTower): void {
    const { towerId, seq } = cmd;
    const lane = this.lanes.get(playerId);
    if (!lane) return;

    const tower = lane.towers.get(towerId);
    if (!tower) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Tower not found" });
      return;
    }
    if (tower.tier >= 3) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Max tier" });
      return;
    }
    const upgrade = tower.config.upgrades[tower.tier];
    if (lane.gold < upgrade.cost) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Not enough gold" });
      return;
    }

    lane.gold -= upgrade.cost;
    tower.tier++;
    tower.dirty = true;
    lane.dirtyScalars = true;
    lane.towersUpserted.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq });
  }

  handleSellTower(playerId: PlayerId, cmd: ClientSellTower): void {
    if (this.mode === "versus") {
      this.versusSellTower(playerId, cmd);
    } else {
      this.coopSellTower(playerId, cmd);
    }
  }

  private coopSellTower(playerId: PlayerId, cmd: ClientSellTower): void {
    const { towerId, seq } = cmd;
    const tower = this.towers.get(towerId);
    if (!tower) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Tower not found" });
      return;
    }
    const refund = Math.floor(tower.config.cost * SELL_REFUND);
    this.gold += refund;
    this.dirtyScalars = true;
    this.towers.delete(towerId);
    this.towersRemoved.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq });
  }

  private versusSellTower(playerId: PlayerId, cmd: ClientSellTower): void {
    const { towerId, seq } = cmd;
    const lane = this.lanes.get(playerId);
    if (!lane) return;

    const tower = lane.towers.get(towerId);
    if (!tower) {
      this.sendFn(playerId, { type: "action_reject", seq, reason: "Tower not found" });
      return;
    }
    const refund = Math.floor(tower.config.cost * SELL_REFUND);
    lane.gold += refund;
    lane.dirtyScalars = true;
    lane.towers.delete(towerId);
    lane.towersRemoved.add(towerId);
    this.sendFn(playerId, { type: "action_ack", seq });
  }

  handleSendAttack(playerId: PlayerId, cmd: ClientSendAttack): void {
    if (this.mode !== "versus") return;
    const lane = this.lanes.get(playerId);
    if (!lane) return;

    const tokens = Math.min(cmd.tokens, lane.attackTokens);
    if (tokens <= 0) return;

    lane.attackTokens -= tokens;
    lane.dirtyScalars = true;

    // Find opponent
    const opponentId = this.getOpponentId(playerId);
    if (!opponentId) return;

    const opponentLane = this.lanes.get(opponentId);
    if (!opponentLane) return;

    const enemyCount = tokens * ENEMIES_PER_TOKEN;
    const attackEnemies = generateAttackEnemies(enemyCount, this.wave);

    // Add to opponent's attack queue
    const baseDelay = opponentLane.attackQueue.length > 0
      ? opponentLane.attackQueue[opponentLane.attackQueue.length - 1].delay + 400
      : 0;
    for (const e of attackEnemies) {
      opponentLane.attackQueue.push({ kind: e.kind, delay: baseDelay + e.delay });
    }

    // Notify opponent
    this.sendFn(opponentId, {
      type: "attack_incoming",
      fromPlayer: playerId,
      enemyCount,
    });
  }

  private getOpponentId(playerId: PlayerId): PlayerId | null {
    for (const id of this.lanes.keys()) {
      if (id !== playerId) return id;
    }
    return null;
  }

  // ── Tick loop ──────────────────────────────────────

  private doTick(): void {
    this.tick++;
    const dt = 1 / TICK_RATE;

    if (this.phase === "gameover" || this.phase === "victory") return;

    if (this.mode === "versus") {
      this.doVersusTick(dt);
    } else {
      this.doCoopTick(dt);
    }

    // Send delta or full state
    if (this.tick % FULL_STATE_INTERVAL === 0) {
      this.broadcastFullState();
    } else {
      this.broadcastDelta();
    }

    // Clear dirty tracking
    this.clearDirty();
  }

  private doCoopTick(dt: number): void {
    if (this.phase === "prep") {
      this.prepTimeRemaining -= dt;
      this.dirtyScalars = true;
      if (this.prepTimeRemaining <= 0) {
        this.prepTimeRemaining = 0;
        this.phase = "combat";
        this.broadcastMsg({
          type: "wave_start",
          wave: this.wave,
          enemyCount: this.waveSpawns.length,
        });
      }
    } else {
      this.updateSpawning(dt);
      this.updateEnemies(dt);
      this.updateTowers(dt);
      this.updateProjectiles(dt);

      if (this.waveSpawnIndex >= this.waveSpawns.length && this.enemies.size === 0) {
        if (this.wave >= MAX_WAVES) {
          this.phase = "victory";
          this.dirtyScalars = true;
          this.broadcastMsg({ type: "victory", wave: this.wave, score: this.score });
          this.stop();
        } else {
          this.startNextWave();
        }
      }
    }
  }

  private doVersusTick(dt: number): void {
    if (this.phase === "prep") {
      this.prepTimeRemaining -= dt;
      this.dirtyScalars = true;
      for (const lane of this.lanes.values()) lane.dirtyScalars = true;

      if (this.prepTimeRemaining <= 0) {
        this.prepTimeRemaining = 0;
        this.phase = "combat";
        for (const lane of this.lanes.values()) {
          this.sendFn(lane.playerId, {
            type: "wave_start",
            wave: this.wave,
            enemyCount: lane.waveSpawns.length,
          });
        }
      }
    } else {
      // Update each lane independently
      for (const lane of this.lanes.values()) {
        this.updateLaneSpawning(lane, dt);
        this.updateLaneAttackSpawning(lane, dt);
        this.updateLaneEnemies(lane, dt);
        this.updateLaneTowers(lane, dt);
        this.updateLaneProjectiles(lane, dt);

        // Check if lane's wave is done
        const spawnDone = lane.waveSpawnIndex >= lane.waveSpawns.length;
        const attackDone = lane.attackSpawnIndex >= lane.attackQueue.length;
        lane.waveComplete = spawnDone && attackDone && lane.enemies.size === 0;
      }

      // Check for player elimination
      for (const lane of this.lanes.values()) {
        if (lane.lives <= 0) {
          lane.lives = 0;
          this.phase = "gameover";
          this.dirtyScalars = true;

          const winnerId = this.getOpponentId(lane.playerId);
          const winner = winnerId ? this.players.get(winnerId) : null;
          const loser = this.players.get(lane.playerId);

          this.broadcastMsg({
            type: "versus_result",
            winner: winnerId ?? "",
            winnerName: winner?.name ?? "Unknown",
            loser: lane.playerId,
            loserName: loser?.name ?? "Unknown",
            wave: this.wave,
          });
          this.stop();
          return;
        }
      }

      // Check if all lanes completed their wave
      const allComplete = Array.from(this.lanes.values()).every((l) => l.waveComplete);
      if (allComplete) {
        if (this.wave >= MAX_WAVES) {
          // Both survived all waves — player with more lives wins
          this.phase = "victory";
          this.dirtyScalars = true;

          const laneArr = Array.from(this.lanes.values());
          const sorted = laneArr.sort((a, b) => b.lives - a.lives || b.score - a.score);
          const winner = this.players.get(sorted[0].playerId);
          const loser = this.players.get(sorted[1].playerId);

          this.broadcastMsg({
            type: "versus_result",
            winner: sorted[0].playerId,
            winnerName: winner?.name ?? "Unknown",
            loser: sorted[1].playerId,
            loserName: loser?.name ?? "Unknown",
            wave: this.wave,
          });
          this.stop();
        } else {
          this.versusWaveComplete();
          this.startNextWave();
        }
      }
    }
  }

  private versusWaveComplete(): void {
    for (const lane of this.lanes.values()) {
      // Award tokens
      let tokens = TOKENS_PER_WAVE;
      if (!lane.leaked) tokens += TOKENS_CLEAN_BONUS;
      lane.attackTokens += tokens;

      // Interest + wave bonus
      const interest = Math.min(Math.floor(lane.gold * INTEREST_RATE), INTEREST_CAP);
      const waveBonus = 10 + this.wave * 2;
      lane.gold += interest + waveBonus;
      lane.dirtyScalars = true;
      lane.leaked = false;

      this.sendFn(lane.playerId, {
        type: "wave_complete",
        wave: this.wave,
        goldBonus: waveBonus,
        interestGold: interest,
      });
    }
  }

  // ── Wave management ────────────────────────────────

  private startNextWave(): void {
    if (this.mode === "versus") {
      if (this.wave > 0) {
        // Wave complete rewards already handled in versusWaveComplete
      }

      this.wave++;
      this.phase = "prep";
      this.prepTimeRemaining = this.wave === 1 ? 3 : 5;
      this.dirtyScalars = true;

      const spawns = generateWave(this.wave);
      for (const lane of this.lanes.values()) {
        lane.waveSpawns = [...spawns]; // clone
        lane.waveSpawnIndex = 0;
        lane.waveSpawnTimer = 0;
        lane.attackSpawnIndex = 0;
        lane.attackSpawnTimer = 0;
        lane.waveComplete = false;
        lane.dirtyScalars = true;
      }
    } else {
      if (this.wave > 0) {
        const interest = Math.min(Math.floor(this.gold * INTEREST_RATE), INTEREST_CAP);
        const waveBonus = 10 + this.wave * 2;
        this.gold += interest + waveBonus;
        this.dirtyScalars = true;

        this.broadcastMsg({
          type: "wave_complete",
          wave: this.wave,
          goldBonus: waveBonus,
          interestGold: interest,
        });
      }

      this.wave++;
      this.phase = "prep";
      this.prepTimeRemaining = this.wave === 1 ? 3 : 5;
      this.waveSpawns = generateWave(this.wave);
      this.waveSpawnIndex = 0;
      this.waveSpawnTimer = 0;
      this.dirtyScalars = true;
    }
  }

  // ── Coop game simulation (unchanged) ──────────────

  private updateSpawning(dt: number): void {
    if (this.waveSpawnIndex >= this.waveSpawns.length) return;
    this.waveSpawnTimer += dt * 1000;
    while (this.waveSpawnIndex < this.waveSpawns.length) {
      const spawn = this.waveSpawns[this.waveSpawnIndex];
      if (this.waveSpawnTimer < spawn.delay) break;
      this.spawnEnemy(spawn.kind);
      this.waveSpawnIndex++;
    }
  }

  private spawnEnemy(kind: EnemyKind): void {
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg) return;
    const startTile = this.map.path[0];
    const ts = this.map.tileSize;
    const id = this.uid();
    const enemy: ServerEnemy = {
      id, kind, hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed,
      armor: cfg.armor, flying: cfg.flying, reward: cfg.reward,
      pathIndex: 0,
      worldPos: { x: tileCenterX(startTile.col, ts), y: tileCenterY(startTile.row, ts) },
      slowFactor: 1, slowDuration: 0, dirty: true,
    };
    this.enemies.set(id, enemy);
    this.enemiesUpserted.add(id);
  }

  private updateEnemies(dt: number): void {
    const ts = this.map.tileSize;
    const path = this.map.path;
    const toRemove: string[] = [];

    for (const enemy of this.enemies.values()) {
      if (enemy.slowDuration > 0) {
        enemy.slowDuration -= dt;
        if (enemy.slowDuration <= 0) { enemy.slowFactor = 1; enemy.slowDuration = 0; }
      }
      const effectiveSpeed = enemy.speed * enemy.slowFactor;
      const nextIdx = Math.floor(enemy.pathIndex) + 1;
      if (nextIdx >= path.length) {
        this.lives--;
        this.dirtyScalars = true;
        toRemove.push(enemy.id);
        continue;
      }
      const target = path[nextIdx];
      const tx = tileCenterX(target.col, ts);
      const ty = tileCenterY(target.row, ts);
      const dx = tx - enemy.worldPos.x;
      const dy = ty - enemy.worldPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const moveAmount = effectiveSpeed * ts * dt;
      if (d <= moveAmount) {
        enemy.worldPos.x = tx;
        enemy.worldPos.y = ty;
        enemy.pathIndex = nextIdx;
      } else {
        enemy.worldPos.x += (dx / d) * moveAmount;
        enemy.worldPos.y += (dy / d) * moveAmount;
      }
      enemy.dirty = true;
      this.enemiesUpserted.add(enemy.id);
    }

    for (const id of toRemove) {
      this.enemies.delete(id);
      this.enemiesRemoved.add(id);
    }

    if (this.lives <= 0) {
      this.lives = 0;
      this.phase = "gameover";
      this.dirtyScalars = true;
      this.broadcastMsg({ type: "game_over", wave: this.wave, score: this.score });
      this.stop();
    }
  }

  private updateTowers(dt: number): void {
    const ts = this.map.tileSize;
    for (const tower of this.towers.values()) {
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;
      const tcx = tileCenterX(tower.pos.col, ts);
      const tcy = tileCenterY(tower.pos.row, ts);
      const stats = effectiveStats(tower.config, tower.tier);
      const rangePx = stats.range * ts;
      let target: ServerEnemy | null = null;
      let minDist = Infinity;
      for (const enemy of this.enemies.values()) {
        const d = dist({ x: tcx, y: tcy }, enemy.worldPos);
        if (d <= rangePx && d < minDist) { minDist = d; target = enemy; }
      }
      if (target) {
        this.fireProjectile(tower, target, { x: tcx, y: tcy }, this.projectiles);
        tower.cooldown = 1 / stats.fireRate;
      }
    }
  }

  private fireProjectile(
    tower: ServerTower,
    target: ServerEnemy,
    from: WorldPos,
    projectiles: ServerProjectile[],
  ): void {
    const stats = effectiveStats(tower.config, tower.tier);
    const chainCount = tower.kind === "lightning" ? 2 + tower.tier : 0;
    projectiles.push({
      id: this.uid(), towerKind: tower.kind, damage: stats.damage,
      splash: stats.splash, speed: tower.kind === "lightning" ? 300 : 200,
      targetId: target.id, worldPos: { ...from }, chainCount, chainHitIds: new Set(),
    });
  }

  private updateProjectiles(dt: number): void {
    this.updateProjectilesForSet(dt, this.projectiles, this.enemies);
  }

  private updateProjectilesForSet(
    dt: number,
    projectiles: ServerProjectile[],
    enemies: Map<string, ServerEnemy>,
    laneGold?: { gold: number; score: number; dirtyScalars: boolean },
    laneTracking?: { enemiesUpserted: Set<string>; enemiesRemoved: Set<string> },
  ): void {
    const ts = this.map.tileSize;
    const toRemove = new Set<number>();

    for (let i = 0; i < projectiles.length; i++) {
      const proj = projectiles[i];
      const target = enemies.get(proj.targetId);
      if (!target) { toRemove.add(i); continue; }

      const dx = target.worldPos.x - proj.worldPos.x;
      const dy = target.worldPos.y - proj.worldPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const moveAmount = proj.speed * dt;

      if (d <= moveAmount) {
        proj.chainHitIds.add(target.id);

        if (proj.towerKind === "frost") {
          this.damageEnemyIn(target, proj.damage, enemies, laneGold, laneTracking);
          target.slowFactor = 0.4;
          target.slowDuration = 2;
        } else if (proj.splash > 0) {
          const splashPx = proj.splash * ts;
          for (const enemy of enemies.values()) {
            if (dist(target.worldPos, enemy.worldPos) <= splashPx) {
              this.damageEnemyIn(enemy, proj.damage, enemies, laneGold, laneTracking);
            }
          }
        } else {
          this.damageEnemyIn(target, proj.damage, enemies, laneGold, laneTracking);
        }

        if (proj.towerKind === "lightning" && proj.chainCount > 0) {
          const chainTarget = this.findChainTargetIn(target.worldPos, proj.chainHitIds, ts * 3, enemies);
          if (chainTarget) {
            proj.targetId = chainTarget.id;
            proj.chainCount--;
            proj.damage = Math.floor(proj.damage * 0.7);
            continue;
          }
        }
        toRemove.add(i);
      } else {
        proj.worldPos.x += (dx / d) * moveAmount;
        proj.worldPos.y += (dy / d) * moveAmount;
      }
    }

    const indices = Array.from(toRemove).sort((a, b) => b - a);
    for (const idx of indices) projectiles.splice(idx, 1);
  }

  private findChainTarget(from: WorldPos, excludeIds: Set<string>, maxRange: number): ServerEnemy | null {
    return this.findChainTargetIn(from, excludeIds, maxRange, this.enemies);
  }

  private findChainTargetIn(
    from: WorldPos,
    excludeIds: Set<string>,
    maxRange: number,
    enemies: Map<string, ServerEnemy>,
  ): ServerEnemy | null {
    let best: ServerEnemy | null = null;
    let bestDist = maxRange;
    for (const enemy of enemies.values()) {
      if (excludeIds.has(enemy.id)) continue;
      const d = dist(from, enemy.worldPos);
      if (d < bestDist) { bestDist = d; best = enemy; }
    }
    return best;
  }

  private damageEnemy(enemy: ServerEnemy, rawDamage: number): void {
    this.damageEnemyIn(enemy, rawDamage, this.enemies);
  }

  private damageEnemyIn(
    enemy: ServerEnemy,
    rawDamage: number,
    enemies: Map<string, ServerEnemy>,
    laneGold?: { gold: number; score: number; dirtyScalars: boolean },
    laneTracking?: { enemiesUpserted: Set<string>; enemiesRemoved: Set<string> },
  ): void {
    const effectiveDamage = Math.max(1, rawDamage - enemy.armor);
    enemy.hp -= effectiveDamage;
    enemy.dirty = true;

    if (laneTracking) {
      laneTracking.enemiesUpserted.add(enemy.id);
    } else {
      this.enemiesUpserted.add(enemy.id);
    }

    if (enemy.hp <= 0) {
      if (laneGold) {
        laneGold.gold += enemy.reward;
        laneGold.score += enemy.reward;
        laneGold.dirtyScalars = true;
      } else {
        this.gold += enemy.reward;
        this.score += enemy.reward;
        this.dirtyScalars = true;
      }

      enemies.delete(enemy.id);
      if (laneTracking) {
        laneTracking.enemiesRemoved.add(enemy.id);
        laneTracking.enemiesUpserted.delete(enemy.id);
      } else {
        this.enemiesRemoved.add(enemy.id);
        this.enemiesUpserted.delete(enemy.id);
      }
    }
  }

  // ── Versus lane simulation ─────────────────────────

  private updateLaneSpawning(lane: VersusLane, dt: number): void {
    if (lane.waveSpawnIndex >= lane.waveSpawns.length) return;
    lane.waveSpawnTimer += dt * 1000;
    while (lane.waveSpawnIndex < lane.waveSpawns.length) {
      const spawn = lane.waveSpawns[lane.waveSpawnIndex];
      if (lane.waveSpawnTimer < spawn.delay) break;
      this.spawnEnemyInLane(lane, spawn.kind);
      lane.waveSpawnIndex++;
    }
  }

  private updateLaneAttackSpawning(lane: VersusLane, dt: number): void {
    if (lane.attackSpawnIndex >= lane.attackQueue.length) return;
    lane.attackSpawnTimer += dt * 1000;
    while (lane.attackSpawnIndex < lane.attackQueue.length) {
      const spawn = lane.attackQueue[lane.attackSpawnIndex];
      if (lane.attackSpawnTimer < spawn.delay) break;
      this.spawnEnemyInLane(lane, spawn.kind);
      lane.attackSpawnIndex++;
    }
  }

  private spawnEnemyInLane(lane: VersusLane, kind: EnemyKind): void {
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg) return;
    const startTile = this.map.path[0];
    const ts = this.map.tileSize;
    const id = this.uid();
    const enemy: ServerEnemy = {
      id, kind, hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed,
      armor: cfg.armor, flying: cfg.flying, reward: cfg.reward,
      pathIndex: 0,
      worldPos: { x: tileCenterX(startTile.col, ts), y: tileCenterY(startTile.row, ts) },
      slowFactor: 1, slowDuration: 0, dirty: true,
    };
    lane.enemies.set(id, enemy);
    lane.enemiesUpserted.add(id);
  }

  private updateLaneEnemies(lane: VersusLane, dt: number): void {
    const ts = this.map.tileSize;
    const path = this.map.path;
    const toRemove: string[] = [];

    for (const enemy of lane.enemies.values()) {
      if (enemy.slowDuration > 0) {
        enemy.slowDuration -= dt;
        if (enemy.slowDuration <= 0) { enemy.slowFactor = 1; enemy.slowDuration = 0; }
      }
      const effectiveSpeed = enemy.speed * enemy.slowFactor;
      const nextIdx = Math.floor(enemy.pathIndex) + 1;
      if (nextIdx >= path.length) {
        lane.lives--;
        lane.dirtyScalars = true;
        lane.leaked = true;
        toRemove.push(enemy.id);
        continue;
      }
      const target = path[nextIdx];
      const tx = tileCenterX(target.col, ts);
      const ty = tileCenterY(target.row, ts);
      const dx = tx - enemy.worldPos.x;
      const dy = ty - enemy.worldPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const moveAmount = effectiveSpeed * ts * dt;
      if (d <= moveAmount) {
        enemy.worldPos.x = tx;
        enemy.worldPos.y = ty;
        enemy.pathIndex = nextIdx;
      } else {
        enemy.worldPos.x += (dx / d) * moveAmount;
        enemy.worldPos.y += (dy / d) * moveAmount;
      }
      enemy.dirty = true;
      lane.enemiesUpserted.add(enemy.id);
    }

    for (const id of toRemove) {
      lane.enemies.delete(id);
      lane.enemiesRemoved.add(id);
    }
  }

  private updateLaneTowers(lane: VersusLane, dt: number): void {
    const ts = this.map.tileSize;
    for (const tower of lane.towers.values()) {
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;
      const tcx = tileCenterX(tower.pos.col, ts);
      const tcy = tileCenterY(tower.pos.row, ts);
      const stats = effectiveStats(tower.config, tower.tier);
      const rangePx = stats.range * ts;
      let target: ServerEnemy | null = null;
      let minDist = Infinity;
      for (const enemy of lane.enemies.values()) {
        const d = dist({ x: tcx, y: tcy }, enemy.worldPos);
        if (d <= rangePx && d < minDist) { minDist = d; target = enemy; }
      }
      if (target) {
        this.fireProjectile(tower, target, { x: tcx, y: tcy }, lane.projectiles);
        tower.cooldown = 1 / stats.fireRate;
      }
    }
  }

  private updateLaneProjectiles(lane: VersusLane, dt: number): void {
    this.updateProjectilesForSet(dt, lane.projectiles, lane.enemies, lane, lane);
  }

  // ── State broadcasting ─────────────────────────────

  private toNetTower(t: ServerTower): NetTower {
    return { id: t.id, kind: t.kind, pos: t.pos, tier: t.tier, ownerId: t.ownerId };
  }

  private toNetEnemy(e: ServerEnemy): NetEnemy {
    return {
      id: e.id, kind: e.kind, hp: e.hp, maxHp: e.maxHp,
      pathIndex: e.pathIndex, worldPos: { ...e.worldPos },
      slowFactor: e.slowFactor, slowDuration: e.slowDuration,
    };
  }

  private toNetProjectile(p: ServerProjectile): NetProjectile {
    return {
      id: p.id, towerKind: p.towerKind, targetId: p.targetId,
      worldPos: { ...p.worldPos }, damage: p.damage, splash: p.splash,
    };
  }

  private buildOpponentSummary(playerId: PlayerId): VersusOpponentSummary | undefined {
    const opponentId = this.getOpponentId(playerId);
    if (!opponentId) return undefined;
    const lane = this.lanes.get(opponentId);
    if (!lane) return undefined;
    const player = this.players.get(opponentId);
    return {
      playerId: opponentId,
      name: player?.name ?? "Opponent",
      lives: lane.lives,
      maxLives: lane.maxLives,
      gold: lane.gold,
      attackTokens: lane.attackTokens,
      towerCount: lane.towers.size,
    };
  }

  buildFullState(): ServerGameState {
    // For coop mode, return shared state
    return {
      type: "game_state",
      tick: this.tick,
      wave: this.wave,
      phase: this.phase,
      prepTimeRemaining: this.prepTimeRemaining,
      gold: this.gold,
      lives: this.lives,
      maxLives: this.maxLives,
      towers: Array.from(this.towers.values()).map((t) => this.toNetTower(t)),
      enemies: Array.from(this.enemies.values()).map((e) => this.toNetEnemy(e)),
      projectiles: this.projectiles.map((p) => this.toNetProjectile(p)),
      score: this.score,
      players: Array.from(this.players.values()),
    };
  }

  private buildVersusFullState(playerId: PlayerId): ServerGameState {
    const lane = this.lanes.get(playerId)!;
    return {
      type: "game_state",
      tick: this.tick,
      wave: this.wave,
      phase: this.phase,
      prepTimeRemaining: this.prepTimeRemaining,
      gold: lane.gold,
      lives: lane.lives,
      maxLives: lane.maxLives,
      towers: Array.from(lane.towers.values()).map((t) => this.toNetTower(t)),
      enemies: Array.from(lane.enemies.values()).map((e) => this.toNetEnemy(e)),
      projectiles: lane.projectiles.map((p) => this.toNetProjectile(p)),
      score: lane.score,
      players: Array.from(this.players.values()),
      attackTokens: lane.attackTokens,
      opponent: this.buildOpponentSummary(playerId),
    };
  }

  private broadcastFullState(): void {
    if (this.mode === "versus") {
      for (const playerId of this.players.keys()) {
        const state = this.buildVersusFullState(playerId);
        const binary = encode(state);
        this.sendFn(playerId, binary as Uint8Array);
      }
    } else {
      const state = this.buildFullState();
      const binary = encode(state);
      for (const playerId of this.players.keys()) {
        this.sendFn(playerId, binary as Uint8Array);
      }
    }
  }

  private broadcastDelta(): void {
    if (this.mode === "versus") {
      for (const playerId of this.players.keys()) {
        this.broadcastVersusDelta(playerId);
      }
    } else {
      this.broadcastCoopDelta();
    }
  }

  private broadcastCoopDelta(): void {
    const delta: ServerGameDelta = { type: "game_delta", tick: this.tick };
    let hasDelta = false;

    if (this.dirtyScalars) {
      delta.wave = this.wave;
      delta.phase = this.phase;
      delta.prepTimeRemaining = this.prepTimeRemaining;
      delta.gold = this.gold;
      delta.lives = this.lives;
      delta.score = this.score;
      hasDelta = true;
    }

    if (this.towersUpserted.size > 0) {
      delta.towersUpsert = [];
      for (const id of this.towersUpserted) {
        const t = this.towers.get(id);
        if (t) delta.towersUpsert.push(this.toNetTower(t));
      }
      hasDelta = true;
    }
    if (this.towersRemoved.size > 0) {
      delta.towersRemove = Array.from(this.towersRemoved);
      hasDelta = true;
    }
    if (this.enemiesUpserted.size > 0) {
      delta.enemiesUpsert = [];
      for (const id of this.enemiesUpserted) {
        const e = this.enemies.get(id);
        if (e) delta.enemiesUpsert.push(this.toNetEnemy(e));
      }
      hasDelta = true;
    }
    if (this.enemiesRemoved.size > 0) {
      delta.enemiesRemove = Array.from(this.enemiesRemoved);
      hasDelta = true;
    }
    if (this.projectiles.length > 0 || hasDelta) {
      delta.projectiles = this.projectiles.map((p) => this.toNetProjectile(p));
      hasDelta = true;
    }

    if (!hasDelta) return;

    const binary = encode(delta);
    for (const playerId of this.players.keys()) {
      this.sendFn(playerId, binary as Uint8Array);
    }
  }

  private broadcastVersusDelta(playerId: PlayerId): void {
    const lane = this.lanes.get(playerId);
    if (!lane) return;

    const delta: ServerGameDelta = { type: "game_delta", tick: this.tick };
    let hasDelta = false;

    if (this.dirtyScalars || lane.dirtyScalars) {
      delta.wave = this.wave;
      delta.phase = this.phase;
      delta.prepTimeRemaining = this.prepTimeRemaining;
      delta.gold = lane.gold;
      delta.lives = lane.lives;
      delta.score = lane.score;
      delta.attackTokens = lane.attackTokens;
      delta.opponent = this.buildOpponentSummary(playerId);
      hasDelta = true;
    }

    if (lane.towersUpserted.size > 0) {
      delta.towersUpsert = [];
      for (const id of lane.towersUpserted) {
        const t = lane.towers.get(id);
        if (t) delta.towersUpsert.push(this.toNetTower(t));
      }
      hasDelta = true;
    }
    if (lane.towersRemoved.size > 0) {
      delta.towersRemove = Array.from(lane.towersRemoved);
      hasDelta = true;
    }
    if (lane.enemiesUpserted.size > 0) {
      delta.enemiesUpsert = [];
      for (const id of lane.enemiesUpserted) {
        const e = lane.enemies.get(id);
        if (e) delta.enemiesUpsert.push(this.toNetEnemy(e));
      }
      hasDelta = true;
    }
    if (lane.enemiesRemoved.size > 0) {
      delta.enemiesRemove = Array.from(lane.enemiesRemoved);
      hasDelta = true;
    }
    if (lane.projectiles.length > 0 || hasDelta) {
      delta.projectiles = lane.projectiles.map((p) => this.toNetProjectile(p));
      hasDelta = true;
    }

    if (!hasDelta) return;

    const binary = encode(delta);
    this.sendFn(playerId, binary as Uint8Array);
  }

  private broadcastMsg(msg: ServerMessage): void {
    for (const playerId of this.players.keys()) {
      this.sendFn(playerId, msg);
    }
  }

  private clearDirty(): void {
    if (this.mode === "versus") {
      for (const lane of this.lanes.values()) {
        lane.towersUpserted.clear();
        lane.towersRemoved.clear();
        lane.enemiesUpserted.clear();
        lane.enemiesRemoved.clear();
        lane.dirtyScalars = false;
        for (const t of lane.towers.values()) t.dirty = false;
        for (const e of lane.enemies.values()) e.dirty = false;
      }
    } else {
      this.towersUpserted.clear();
      this.towersRemoved.clear();
      this.enemiesUpserted.clear();
      this.enemiesRemoved.clear();
      this.dirtyScalars = false;
      for (const t of this.towers.values()) t.dirty = false;
      for (const e of this.enemies.values()) e.dirty = false;
    }
  }
}
