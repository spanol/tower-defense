/**
 * MultiplayerGameScene — renders authoritative server state.
 * Sends player commands (place/upgrade/sell tower) to server.
 * Receives full state snapshots and deltas via binary protocol.
 *
 * Supports both co-op and versus modes. In versus mode, shows
 * opponent health bar, attack token count, and send-attack button.
 */

import Phaser from "phaser";
import {
  MAPS,
  TOWER_CONFIGS,
  type GameMap,
  type TilePos,
  type TowerKind,
  type GameMode,
  type VersusOpponentSummary,
} from "@td/shared";
import type {
  ServerMessage,
  ServerGameState,
  ServerGameDelta,
  ServerVersusResult,
  ServerAttackIncoming,
  NetTower,
  NetEnemy,
  NetProjectile,
} from "@td/shared";
import { net } from "../network.js";

// ── Colors (same as single-player) ────────────────────
const COLORS: Record<string, number> = {
  path: 0x8b7355,
  buildable: 0x228b22,
  blocked: 0x2d2d2d,
  start: 0x4488ff,
  end: 0xff4444,
  arrow: 0xffcc00,
  cannon: 0xff6600,
  frost: 0x66ccff,
  lightning: 0xaa66ff,
  mortar: 0x996633,
  enemy_basic: 0xff0000,
  enemy_fast: 0xff66ff,
  enemy_armored: 0x888888,
  enemy_flying: 0x44ddff,
  enemy_boss: 0xff2222,
  projectile: 0xffffff,
  projectile_frost: 0x88ddff,
  projectile_lightning: 0xcc88ff,
  range: 0x44ff44,
  hpBar: 0x00ff00,
  hpBg: 0x333333,
};

function tileCenterX(col: number, tileSize: number): number {
  return col * tileSize + tileSize / 2;
}
function tileCenterY(row: number, tileSize: number): number {
  return row * tileSize + tileSize / 2;
}

// ── Visual entity wrappers ─────────────────────────────

interface TowerVisual {
  data: NetTower;
  graphic: Phaser.GameObjects.Rectangle;
  rangeCircle: Phaser.GameObjects.Arc;
  tierLabel: Phaser.GameObjects.Text;
}

interface EnemyVisual {
  data: NetEnemy;
  graphic: Phaser.GameObjects.Arc;
  hpBar: Phaser.GameObjects.Rectangle;
  hpBg: Phaser.GameObjects.Rectangle;
}

interface ProjectileVisual {
  data: NetProjectile;
  graphic: Phaser.GameObjects.Arc;
}

// ── MultiplayerGameScene ──────────────────────────────

export class MultiplayerGameScene extends Phaser.Scene {
  private mapKey = "forest";
  private gameMode: GameMode = "coop";
  private map!: GameMap;

  // Server state
  private gold = 0;
  private lives = 0;
  private maxLives = 20;
  private wave = 0;
  private phase: "prep" | "combat" | "gameover" | "victory" = "prep";
  private prepTimeRemaining = 0;
  private score = 0;

  // Versus state
  private attackTokens = 0;
  private opponent: VersusOpponentSummary | null = null;
  private versusResult: ServerVersusResult | null = null;

  // Visual entities
  private towerVisuals = new Map<string, TowerVisual>();
  private enemyVisuals = new Map<string, EnemyVisual>();
  private projectileVisuals = new Map<string, ProjectileVisual>();

  // UI state
  private selectedTower: TowerKind = "arrow";
  private selectedPlacedTowerId: string | null = null;
  private upgradePanel: Phaser.GameObjects.Container | null = null;

  // HUD
  private goldText!: Phaser.GameObjects.Text;
  private livesText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;
  private towerPickerTexts: Phaser.GameObjects.Text[] = [];

  // Versus HUD
  private opponentPanel: Phaser.GameObjects.Container | null = null;
  private opponentLivesText: Phaser.GameObjects.Text | null = null;
  private opponentGoldText: Phaser.GameObjects.Text | null = null;
  private opponentNameText: Phaser.GameObjects.Text | null = null;
  private attackTokenText: Phaser.GameObjects.Text | null = null;
  private attackBtn: Phaser.GameObjects.Text | null = null;
  private attackNotice: Phaser.GameObjects.Text | null = null;
  private resultOverlay: Phaser.GameObjects.Container | null = null;

  constructor() {
    super({ key: "MultiplayerGameScene" });
  }

  init(data: { mapKey?: string; mode?: GameMode; initialState?: ServerGameState }) {
    this.mapKey = data.mapKey ?? "forest";
    this.gameMode = data.mode ?? "coop";
    this.attackTokens = 0;
    this.opponent = null;
    this.versusResult = null;
    if (data.initialState) {
      this.applyFullState(data.initialState);
    }
  }

  create() {
    this.map = MAPS[this.mapKey] ?? MAPS.forest;
    this.towerVisuals.clear();
    this.enemyVisuals.clear();
    this.projectileVisuals.clear();
    this.upgradePanel = null;
    this.selectedPlacedTowerId = null;
    this.opponentPanel = null;
    this.resultOverlay = null;

    this.drawMap();
    this.createHUD();

    if (this.gameMode === "versus") {
      this.createVersusHUD();
    }

    net.onMessage((msg) => this.handleServerMessage(msg));

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.phase === "gameover" || this.phase === "victory") return;
      this.handleClick(pointer);
    });
  }

  // ── Map rendering ────────────────────────────────────

  private drawMap(): void {
    const { cols, rows, tileSize, tiles } = this.map;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const type = tiles[r][c];
        let color = COLORS.blocked;
        if (type === "path") color = COLORS.path;
        else if (type === "buildable") color = COLORS.buildable;
        else if (type === "start") color = COLORS.start;
        else if (type === "end") color = COLORS.end;

        this.add.rectangle(
          c * tileSize + tileSize / 2,
          r * tileSize + tileSize / 2,
          tileSize - 1,
          tileSize - 1,
          color,
        );
      }
    }
  }

  // ── HUD ──────────────────────────────────────────────

  private createHUD(): void {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: "11px",
      color: "#ffffff",
      fontFamily: "monospace",
      backgroundColor: "#00000088",
      padding: { x: 3, y: 2 },
    };

    this.goldText = this.add.text(4, 2, "", style).setDepth(10);
    this.livesText = this.add.text(80, 2, "", style).setDepth(10);
    this.waveText = this.add.text(155, 2, "", style).setDepth(10);
    this.phaseText = this.add.text(260, 2, "", style).setDepth(10);

    const modeLabel = this.gameMode === "coop" ? "CO-OP" : "VS";
    const modeColor = this.gameMode === "versus" ? "#ff8844" : "#88ff88";
    this.modeText = this.add.text(370, 2, modeLabel, { ...style, color: modeColor }).setDepth(10);

    // Tower picker at bottom
    const towerKinds: TowerKind[] = ["arrow", "cannon", "frost", "lightning", "mortar"];
    const pickerY = this.map.rows * this.map.tileSize - 16;
    towerKinds.forEach((kind, i) => {
      const cfg = TOWER_CONFIGS[kind];
      const shortName = cfg.name.replace(" Tower", "");
      const txt = this.add
        .text(4 + i * 95, pickerY, `[${shortName} $${cfg.cost}]`, {
          fontSize: "9px",
          color: "#ffcc00",
          fontFamily: "monospace",
          backgroundColor: "#00000088",
          padding: { x: 2, y: 1 },
        })
        .setDepth(10)
        .setInteractive({ useHandCursor: true });

      txt.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.selectedTower = kind;
        this.closeUpgradePanel();
        this.updateHUD();
      });
      this.towerPickerTexts.push(txt);
    });

    this.updateHUD();
  }

  private createVersusHUD(): void {
    const canvasWidth = this.map.cols * this.map.tileSize;
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: "9px",
      color: "#ffffff",
      fontFamily: "monospace",
    };

    // Opponent info panel (top-right)
    this.opponentPanel = this.add.container(canvasWidth - 5, 2).setDepth(10);

    const bg = this.add.rectangle(0, 0, 130, 44, 0x000000, 0.75).setOrigin(1, 0);
    this.opponentPanel.add(bg);

    this.opponentNameText = this.add.text(-125, 3, "Opponent", { ...style, color: "#ff8844" });
    this.opponentPanel.add(this.opponentNameText);

    this.opponentLivesText = this.add.text(-125, 15, "Lives: 20", style);
    this.opponentPanel.add(this.opponentLivesText);

    this.opponentGoldText = this.add.text(-60, 15, "Gold: 200", style);
    this.opponentPanel.add(this.opponentGoldText);

    // Attack tokens + send button (bottom-right, above tower picker)
    const bottomY = this.map.rows * this.map.tileSize - 34;

    this.attackTokenText = this.add
      .text(canvasWidth - 130, bottomY, "Tokens: 0", {
        ...style,
        fontSize: "10px",
        color: "#ffaa00",
        backgroundColor: "#00000088",
        padding: { x: 3, y: 2 },
      })
      .setDepth(10);

    this.attackBtn = this.add
      .text(canvasWidth - 55, bottomY, "[ATTACK]", {
        ...style,
        fontSize: "10px",
        color: "#ff4444",
        backgroundColor: "#330000",
        padding: { x: 3, y: 2 },
      })
      .setDepth(10)
      .setInteractive({ useHandCursor: true });

    this.attackBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      pointer.event.stopPropagation();
      if (this.attackTokens > 0) {
        net.send({ type: "send_attack", tokens: this.attackTokens });
      }
    });

    // Attack incoming notice (center, fades)
    this.attackNotice = this.add
      .text(canvasWidth / 2, 60, "", {
        fontSize: "14px",
        color: "#ff4444",
        fontFamily: "monospace",
        backgroundColor: "#00000088",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5)
      .setDepth(20)
      .setAlpha(0);
  }

  private updateHUD(): void {
    this.goldText.setText(`Gold: ${this.gold}`);
    this.livesText.setText(`Lives: ${this.lives}`);
    this.waveText.setText(`Wave: ${this.wave}/25`);

    if (this.phase === "prep") {
      this.phaseText.setText(`Prep: ${Math.ceil(this.prepTimeRemaining)}s`);
    } else if (this.phase === "combat") {
      this.phaseText.setText(`Enemies: ${this.enemyVisuals.size}`);
    } else if (this.phase === "gameover") {
      this.phaseText.setText("GAME OVER");
    } else if (this.phase === "victory") {
      this.phaseText.setText("VICTORY!");
    }

    const towerKinds: TowerKind[] = ["arrow", "cannon", "frost", "lightning", "mortar"];
    towerKinds.forEach((k, i) => {
      const txt = this.towerPickerTexts[i];
      if (txt) {
        txt.setColor(k === this.selectedTower ? "#ffffff" : "#ffcc00");
      }
    });

    // Versus HUD updates
    if (this.gameMode === "versus") {
      this.updateVersusHUD();
    }
  }

  private updateVersusHUD(): void {
    if (this.opponent) {
      this.opponentNameText?.setText(this.opponent.name);
      this.opponentLivesText?.setText(`Lives: ${this.opponent.lives}`);
      this.opponentGoldText?.setText(`Gold: ${this.opponent.gold}`);
    }

    this.attackTokenText?.setText(`Tokens: ${this.attackTokens}`);

    if (this.attackBtn) {
      const canAttack = this.attackTokens > 0;
      this.attackBtn.setColor(canAttack ? "#ff4444" : "#666666");
      this.attackBtn.setBackgroundColor(canAttack ? "#330000" : "#111111");
    }
  }

  private showAttackNotice(enemyCount: number): void {
    if (!this.attackNotice) return;
    this.attackNotice.setText(`INCOMING ATTACK: ${enemyCount} enemies!`);
    this.attackNotice.setAlpha(1);

    this.tweens.add({
      targets: this.attackNotice,
      alpha: 0,
      duration: 2500,
      ease: "Power2",
    });
  }

  private showVersusResult(result: ServerVersusResult): void {
    this.versusResult = result;
    const canvasW = this.map.cols * this.map.tileSize;
    const canvasH = this.map.rows * this.map.tileSize;

    this.resultOverlay = this.add.container(canvasW / 2, canvasH / 2).setDepth(30);

    const bg = this.add.rectangle(0, 0, 250, 100, 0x000000, 0.9);
    this.resultOverlay.add(bg);

    const style = { fontSize: "14px", color: "#ffffff", fontFamily: "monospace" };

    const title = this.add.text(0, -30, `${result.winnerName} WINS!`, {
      ...style,
      fontSize: "18px",
      color: "#ffcc00",
    }).setOrigin(0.5);
    this.resultOverlay.add(title);

    const detail = this.add.text(0, 0, `${result.loserName} eliminated on wave ${result.wave}`, {
      ...style,
      fontSize: "10px",
      color: "#aaaaaa",
    }).setOrigin(0.5);
    this.resultOverlay.add(detail);

    const backBtn = this.add.text(0, 30, "[ Back to Menu ]", {
      ...style,
      fontSize: "12px",
      color: "#44ff44",
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    backBtn.on("pointerdown", () => {
      net.disconnect();
      this.scene.start("MenuScene");
    });
    this.resultOverlay.add(backBtn);
  }

  // ── Upgrade panel ────────────────────────────────────

  private showUpgradePanel(towerId: string): void {
    this.closeUpgradePanel();
    this.selectedPlacedTowerId = towerId;

    const visual = this.towerVisuals.get(towerId);
    if (!visual) return;

    const tower = visual.data;
    const cfg = TOWER_CONFIGS[tower.kind];
    if (!cfg) return;

    const ts = this.map.tileSize;
    const cx = tileCenterX(tower.pos.col, ts);
    const cy = tileCenterY(tower.pos.row, ts);

    const container = this.add.container(cx, cy - ts - 10).setDepth(20);

    const tierLabel = tower.tier >= 3 ? "MAX" : `T${tower.tier}`;
    const bg = this.add.rectangle(0, 0, 120, 52, 0x000000, 0.85).setOrigin(0.5);
    container.add(bg);

    const infoStyle = { fontSize: "8px", color: "#cccccc", fontFamily: "monospace" };
    const info = this.add.text(-55, -22, `${cfg.name} [${tierLabel}]`, infoStyle);
    container.add(info);

    if (tower.tier < 3) {
      const upgrade = cfg.upgrades[tower.tier];
      const canAfford = this.gold >= upgrade.cost;
      const btnColor = canAfford ? "#44ff44" : "#ff4444";
      const btn = this.add
        .text(-55, 6, `[Upgrade $${upgrade.cost}]`, {
          fontSize: "9px",
          color: btnColor,
          fontFamily: "monospace",
          backgroundColor: "#222222",
          padding: { x: 2, y: 1 },
        })
        .setInteractive({ useHandCursor: true });

      btn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        net.send({ type: "upgrade_tower", towerId: tower.id, seq: net.nextSeq() });
      });
      container.add(btn);
    }

    const sellValue = Math.floor(cfg.cost * 0.6);
    const sellBtn = this.add
      .text(20, 6, `[Sell $${sellValue}]`, {
        fontSize: "9px",
        color: "#ffaa00",
        fontFamily: "monospace",
        backgroundColor: "#222222",
        padding: { x: 2, y: 1 },
      })
      .setInteractive({ useHandCursor: true });

    sellBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      pointer.event.stopPropagation();
      net.send({ type: "sell_tower", towerId: tower.id, seq: net.nextSeq() });
      this.closeUpgradePanel();
    });
    container.add(sellBtn);

    this.upgradePanel = container;
  }

  private closeUpgradePanel(): void {
    if (this.upgradePanel) {
      this.upgradePanel.destroy();
      this.upgradePanel = null;
    }
    this.selectedPlacedTowerId = null;
  }

  // ── Click handler ────────────────────────────────────

  private handleClick(pointer: Phaser.Input.Pointer): void {
    const col = Math.floor(pointer.x / this.map.tileSize);
    const row = Math.floor(pointer.y / this.map.tileSize);

    if (row < 0 || row >= this.map.rows || col < 0 || col >= this.map.cols) return;

    for (const [id, visual] of this.towerVisuals) {
      if (visual.data.pos.col === col && visual.data.pos.row === row) {
        this.showUpgradePanel(id);
        return;
      }
    }

    this.closeUpgradePanel();

    if (this.map.tiles[row][col] !== "buildable") return;

    const cfg = TOWER_CONFIGS[this.selectedTower];
    if (!cfg || this.gold < cfg.cost) return;

    net.send({
      type: "place_tower",
      kind: this.selectedTower,
      pos: { col, row },
      seq: net.nextSeq(),
    });
  }

  // ── Server message handling ──────────────────────────

  private handleServerMessage(msg: ServerMessage | ServerGameState | ServerGameDelta): void {
    switch (msg.type) {
      case "game_state":
        this.applyFullState(msg as ServerGameState);
        this.syncVisuals();
        this.updateHUD();
        break;

      case "game_delta":
        this.applyDelta(msg as ServerGameDelta);
        this.syncVisuals();
        this.updateHUD();
        break;

      case "wave_start":
        break;

      case "wave_complete":
        break;

      case "game_over":
        this.phase = "gameover";
        this.updateHUD();
        break;

      case "victory":
        this.phase = "victory";
        this.updateHUD();
        break;

      case "versus_result":
        this.phase = "gameover";
        this.showVersusResult(msg as ServerVersusResult);
        this.updateHUD();
        break;

      case "attack_incoming":
        this.showAttackNotice((msg as ServerAttackIncoming).enemyCount);
        break;

      case "action_ack":
        break;

      case "action_reject":
        break;

      case "error":
        console.warn("Server error:", (msg as { message: string }).message);
        break;

      default:
        break;
    }
  }

  private applyFullState(state: ServerGameState): void {
    this.wave = state.wave;
    this.phase = state.phase;
    this.prepTimeRemaining = state.prepTimeRemaining;
    this.gold = state.gold;
    this.lives = state.lives;
    this.maxLives = state.maxLives;
    this.score = state.score;

    // Versus fields
    if (state.attackTokens !== undefined) this.attackTokens = state.attackTokens;
    if (state.opponent) this.opponent = state.opponent;

    // Rebuild tower map
    const newTowerIds = new Set(state.towers.map((t) => t.id));
    for (const id of this.towerVisuals.keys()) {
      if (!newTowerIds.has(id)) this.removeTowerVisual(id);
    }
    for (const t of state.towers) {
      this.upsertTower(t);
    }

    // Rebuild enemy map
    const newEnemyIds = new Set(state.enemies.map((e) => e.id));
    for (const id of this.enemyVisuals.keys()) {
      if (!newEnemyIds.has(id)) this.removeEnemyVisual(id);
    }
    for (const e of state.enemies) {
      this.upsertEnemy(e);
    }

    // Replace projectiles
    for (const visual of this.projectileVisuals.values()) {
      visual.graphic.destroy();
    }
    this.projectileVisuals.clear();
    for (const p of state.projectiles) {
      this.upsertProjectile(p);
    }
  }

  private applyDelta(delta: ServerGameDelta): void {
    if (delta.wave !== undefined) this.wave = delta.wave;
    if (delta.phase !== undefined) this.phase = delta.phase;
    if (delta.prepTimeRemaining !== undefined) this.prepTimeRemaining = delta.prepTimeRemaining;
    if (delta.gold !== undefined) this.gold = delta.gold;
    if (delta.lives !== undefined) this.lives = delta.lives;
    if (delta.score !== undefined) this.score = delta.score;

    // Versus fields
    if (delta.attackTokens !== undefined) this.attackTokens = delta.attackTokens;
    if (delta.opponent) this.opponent = delta.opponent;

    if (delta.towersUpsert) {
      for (const t of delta.towersUpsert) this.upsertTower(t);
    }
    if (delta.towersRemove) {
      for (const id of delta.towersRemove) this.removeTowerVisual(id);
    }
    if (delta.enemiesUpsert) {
      for (const e of delta.enemiesUpsert) this.upsertEnemy(e);
    }
    if (delta.enemiesRemove) {
      for (const id of delta.enemiesRemove) this.removeEnemyVisual(id);
    }
    if (delta.projectiles !== undefined) {
      const newIds = new Set(delta.projectiles.map((p) => p.id));
      for (const [id, visual] of this.projectileVisuals) {
        if (!newIds.has(id)) {
          visual.graphic.destroy();
          this.projectileVisuals.delete(id);
        }
      }
      for (const p of delta.projectiles) {
        this.upsertProjectile(p);
      }
    }
  }

  // ── Visual sync ──────────────────────────────────────

  private upsertTower(data: NetTower): void {
    const ts = this.map.tileSize;
    const cx = tileCenterX(data.pos.col, ts);
    const cy = tileCenterY(data.pos.row, ts);

    const existing = this.towerVisuals.get(data.id);
    if (existing) {
      existing.data = data;
      existing.tierLabel.setText(data.tier > 0 ? `${data.tier}` : "");
      const cfg = TOWER_CONFIGS[data.kind];
      if (cfg) {
        let range = cfg.range;
        for (let t = 0; t < data.tier && t < cfg.upgrades.length; t++) {
          range *= cfg.upgrades[t].rangeMultiplier;
        }
        existing.rangeCircle.setRadius(range * ts);
      }
      return;
    }

    const color = COLORS[data.kind] ?? COLORS.arrow;
    const graphic = this.add.rectangle(cx, cy, ts - 4, ts - 4, color).setDepth(2);

    const cfg = TOWER_CONFIGS[data.kind];
    let range = cfg?.range ?? 3;
    if (cfg) {
      for (let t = 0; t < data.tier && t < cfg.upgrades.length; t++) {
        range *= cfg.upgrades[t].rangeMultiplier;
      }
    }

    const rangeCircle = this.add
      .circle(cx, cy, range * ts, COLORS.range, 0.08)
      .setDepth(1)
      .setStrokeStyle(1, COLORS.range, 0.3);

    const tierLabel = this.add
      .text(cx + ts / 4, cy - ts / 4, data.tier > 0 ? `${data.tier}` : "", {
        fontSize: "8px",
        color: "#ffffff",
        fontFamily: "monospace",
      })
      .setDepth(3)
      .setOrigin(0.5);

    this.towerVisuals.set(data.id, { data, graphic, rangeCircle, tierLabel });
  }

  private removeTowerVisual(id: string): void {
    const visual = this.towerVisuals.get(id);
    if (!visual) return;
    visual.graphic.destroy();
    visual.rangeCircle.destroy();
    visual.tierLabel.destroy();
    this.towerVisuals.delete(id);

    if (this.selectedPlacedTowerId === id) {
      this.closeUpgradePanel();
    }
  }

  private upsertEnemy(data: NetEnemy): void {
    const ts = this.map.tileSize;
    const existing = this.enemyVisuals.get(data.id);

    if (existing) {
      existing.data = data;
      existing.graphic.setPosition(data.worldPos.x, data.worldPos.y);
      existing.graphic.setAlpha(data.slowFactor < 1 ? 0.7 : 1);

      existing.hpBg.setPosition(data.worldPos.x, data.worldPos.y - ts / 2.5);
      const hpPct = data.hp / data.maxHp;
      const barWidth = (ts - 4) * hpPct;
      existing.hpBar.setPosition(data.worldPos.x - ((ts - 4) - barWidth) / 2, data.worldPos.y - ts / 2.5);
      existing.hpBar.setSize(barWidth, 3);
      return;
    }

    const colorKey = `enemy_${data.kind}`;
    const color = COLORS[colorKey] ?? COLORS.enemy_basic;
    const radius = data.kind === "boss" ? ts / 2.2 : ts / 3;

    const graphic = this.add.circle(data.worldPos.x, data.worldPos.y, radius, color).setDepth(3);
    if (data.kind === "flying") {
      graphic.setStrokeStyle(2, 0xffffff, 0.6);
    }

    const hpBg = this.add.rectangle(data.worldPos.x, data.worldPos.y - ts / 2.5, ts - 4, 3, COLORS.hpBg).setDepth(4);
    const hpBar = this.add.rectangle(data.worldPos.x, data.worldPos.y - ts / 2.5, ts - 4, 3, COLORS.hpBar).setDepth(5);
    if (data.kind === "boss") {
      hpBar.setFillStyle(0xff6600);
    }

    this.enemyVisuals.set(data.id, { data, graphic, hpBar, hpBg });
  }

  private removeEnemyVisual(id: string): void {
    const visual = this.enemyVisuals.get(id);
    if (!visual) return;
    visual.graphic.destroy();
    visual.hpBar.destroy();
    visual.hpBg.destroy();
    this.enemyVisuals.delete(id);
  }

  private upsertProjectile(data: NetProjectile): void {
    const existing = this.projectileVisuals.get(data.id);
    if (existing) {
      existing.data = data;
      existing.graphic.setPosition(data.worldPos.x, data.worldPos.y);
      return;
    }

    let projColor = COLORS.projectile;
    if (data.towerKind === "frost") projColor = COLORS.projectile_frost;
    else if (data.towerKind === "lightning") projColor = COLORS.projectile_lightning;

    const graphic = this.add.circle(data.worldPos.x, data.worldPos.y, 3, projColor).setDepth(6);
    this.projectileVisuals.set(data.id, { data, graphic });
  }

  private syncVisuals(): void {
    for (const [id, visual] of this.projectileVisuals) {
      if (!visual.data) {
        visual.graphic.destroy();
        this.projectileVisuals.delete(id);
      }
    }
  }

  update(): void {
    // HUD updates happen on message receipt
  }
}
