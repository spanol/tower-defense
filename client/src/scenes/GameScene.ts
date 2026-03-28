import Phaser from "phaser";
import {
  MAPS,
  DEFAULT_MAP,
  MAP_KEYS,
  TOWER_CONFIGS,
  ENEMY_CONFIGS,
  type GameMap,
  type TilePos,
  type WorldPos,
  type TowerKind,
  type EnemyKind,
  type TowerConfig,
} from "@td/shared";
import { audio } from "../audio.js";

// ── Color palette ──────────────────────────────────────
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

// ── Runtime entity types ───────────────────────────────
interface Tower {
  id: string;
  kind: TowerKind;
  config: TowerConfig;
  pos: TilePos;
  tier: number;
  cooldown: number;
  graphic: Phaser.GameObjects.Rectangle;
  rangeCircle: Phaser.GameObjects.Arc;
  tierLabel: Phaser.GameObjects.Text;
}

interface Enemy {
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
  graphic: Phaser.GameObjects.Arc;
  hpBar: Phaser.GameObjects.Rectangle;
  hpBg: Phaser.GameObjects.Rectangle;
  slowFactor: number;
  slowDuration: number;
}

interface Projectile {
  id: string;
  towerKind: TowerKind;
  damage: number;
  splash: number;
  speed: number;
  targetId: string;
  worldPos: WorldPos;
  graphic: Phaser.GameObjects.Arc;
  /** Number of chain bounces remaining (lightning) */
  chainCount: number;
  /** Enemies already hit by this chain */
  chainHitIds: Set<string>;
}

// ── Economy constants ──────────────────────────────────
const INTEREST_RATE = 0.05;
const INTEREST_CAP = 500;
const STARTING_GOLD = 200;
const STARTING_LIVES = 20;
const MAX_WAVES = 25;

// ── Wave generation ────────────────────────────────────
function generateWave(waveNum: number): { kind: EnemyKind; delay: number }[] {
  const budget = 50 + waveNum * 35;
  const isBoss = waveNum % 5 === 0;
  const enemies: { kind: EnemyKind; delay: number }[] = [];

  if (isBoss) {
    // Boss wave: one boss + escort
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

// ── Helpers ────────────────────────────────────────────
let nextId = 0;
function uid(): string {
  return `e${++nextId}`;
}

function tileCenterX(col: number, tileSize: number): number {
  return col * tileSize + tileSize / 2;
}
function tileCenterY(row: number, tileSize: number): number {
  return row * tileSize + tileSize / 2;
}
function dist(a: WorldPos, b: WorldPos): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Get effective tower stats accounting for upgrade tier */
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

// ── GameScene ──────────────────────────────────────────
export class GameScene extends Phaser.Scene {
  private mapKey = DEFAULT_MAP;
  private map!: GameMap;
  private towers: Tower[] = [];
  private enemies: Enemy[] = [];
  private enemyIndex = new Map<string, Enemy>();
  private projectiles: Projectile[] = [];

  private gold = STARTING_GOLD;
  private lives = STARTING_LIVES;
  private wave = 0;
  private phase: "prep" | "combat" | "gameover" | "victory" = "prep";
  private prepTimer = 5;
  private selectedTower: TowerKind = "arrow";
  private selectedPlacedTower: Tower | null = null;

  private waveSpawns: { kind: EnemyKind; delay: number }[] = [];
  private waveSpawnTimer = 0;
  private waveSpawnIndex = 0;

  // HUD elements
  private goldText!: Phaser.GameObjects.Text;
  private livesText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private interestText!: Phaser.GameObjects.Text;
  private towerPickerTexts: Phaser.GameObjects.Text[] = [];
  private upgradePanel: Phaser.GameObjects.Container | null = null;

  constructor() {
    super({ key: "GameScene" });
  }

  init(data: { mapKey?: string }) {
    if (data.mapKey && MAPS[data.mapKey]) {
      this.mapKey = data.mapKey;
    }
  }

  create() {
    this.map = MAPS[this.mapKey];
    this.towers = [];
    this.enemies = [];
    this.enemyIndex.clear();
    this.projectiles = [];
    this.gold = STARTING_GOLD;
    this.lives = STARTING_LIVES;
    this.wave = 0;
    this.phase = "prep";
    this.prepTimer = 5;
    this.selectedPlacedTower = null;
    this.upgradePanel = null;
    nextId = 0;

    this.drawMap();
    this.createHUD();
    this.startNextWave();

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.phase === "gameover" || this.phase === "victory") return;
      this.handleClick(pointer);
    });
  }

  // ── Map rendering ──────────────────────────────────
  private drawMap() {
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

  // ── HUD ────────────────────────────────────────────
  private createHUD() {
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
    this.interestText = this.add.text(370, 2, "", style).setDepth(10);

    // Tower picker at bottom — all 5 towers
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

  private updateHUD() {
    this.goldText.setText(`Gold: ${this.gold}`);
    this.livesText.setText(`Lives: ${this.lives}`);
    this.waveText.setText(`Wave: ${this.wave}/${MAX_WAVES}`);

    const interestGain = Math.min(Math.floor(this.gold * INTEREST_RATE), INTEREST_CAP);
    this.interestText.setText(`+${interestGain}g int`);

    if (this.phase === "prep") {
      this.phaseText.setText(`Prep: ${Math.ceil(this.prepTimer)}s`);
    } else if (this.phase === "combat") {
      this.phaseText.setText(`Enemies: ${this.enemies.length}`);
    } else if (this.phase === "gameover") {
      this.phaseText.setText("GAME OVER");
    } else if (this.phase === "victory") {
      this.phaseText.setText("VICTORY!");
    }

    // Highlight selected tower in picker
    const towerKinds: TowerKind[] = ["arrow", "cannon", "frost", "lightning", "mortar"];
    towerKinds.forEach((k, i) => {
      const txt = this.towerPickerTexts[i];
      if (txt) {
        txt.setColor(k === this.selectedTower ? "#ffffff" : "#ffcc00");
      }
    });
  }

  // ── Upgrade panel ──────────────────────────────────
  private showUpgradePanel(tower: Tower) {
    this.closeUpgradePanel();
    this.selectedPlacedTower = tower;

    const ts = this.map.tileSize;
    const cx = tileCenterX(tower.pos.col, ts);
    const cy = tileCenterY(tower.pos.row, ts);

    const container = this.add.container(cx, cy - ts - 10).setDepth(20);

    const stats = effectiveStats(tower.config, tower.tier);
    const tierLabel = tower.tier >= 3 ? "MAX" : `T${tower.tier}`;

    // Panel background
    const bg = this.add.rectangle(0, 0, 120, 52, 0x000000, 0.85).setOrigin(0.5);
    container.add(bg);

    const infoStyle = { fontSize: "8px", color: "#cccccc", fontFamily: "monospace" };
    const info = this.add.text(-55, -22, `${tower.config.name} [${tierLabel}]\nDmg:${stats.damage} Rng:${stats.range.toFixed(1)} Rate:${stats.fireRate.toFixed(1)}`, infoStyle);
    container.add(info);

    if (tower.tier < 3) {
      const upgrade = tower.config.upgrades[tower.tier];
      const canAfford = this.gold >= upgrade.cost;
      const btnColor = canAfford ? "#44ff44" : "#ff4444";
      const btn = this.add.text(-55, 6, `[Upgrade $${upgrade.cost}]`, {
        fontSize: "9px",
        color: btnColor,
        fontFamily: "monospace",
        backgroundColor: "#222222",
        padding: { x: 2, y: 1 },
      }).setInteractive({ useHandCursor: true });

      btn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.upgradeTower(tower);
      });
      container.add(btn);
    }

    // Sell button
    const sellValue = Math.floor(tower.config.cost * 0.6);
    const sellBtn = this.add.text(20, 6, `[Sell $${sellValue}]`, {
      fontSize: "9px",
      color: "#ffaa00",
      fontFamily: "monospace",
      backgroundColor: "#222222",
      padding: { x: 2, y: 1 },
    }).setInteractive({ useHandCursor: true });

    sellBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      pointer.event.stopPropagation();
      this.sellTower(tower);
    });
    container.add(sellBtn);

    this.upgradePanel = container;
  }

  private closeUpgradePanel() {
    if (this.upgradePanel) {
      this.upgradePanel.destroy();
      this.upgradePanel = null;
    }
    this.selectedPlacedTower = null;
  }

  private upgradeTower(tower: Tower) {
    if (tower.tier >= 3) return;
    const upgrade = tower.config.upgrades[tower.tier];
    if (this.gold < upgrade.cost) return;

    this.gold -= upgrade.cost;
    tower.tier++;

    // Update range circle
    const stats = effectiveStats(tower.config, tower.tier);
    const ts = this.map.tileSize;
    tower.rangeCircle.setRadius(stats.range * ts);

    // Update tier label
    tower.tierLabel.setText(tower.tier > 0 ? `${tower.tier}` : "");

    audio.play("tower_upgrade");
    this.showUpgradePanel(tower);
    this.updateHUD();
  }

  private sellTower(tower: Tower) {
    const sellValue = Math.floor(tower.config.cost * 0.6);
    this.gold += sellValue;

    tower.graphic.destroy();
    tower.rangeCircle.destroy();
    tower.tierLabel.destroy();
    const idx = this.towers.indexOf(tower);
    if (idx !== -1) this.towers.splice(idx, 1);

    audio.play("tower_sell");
    this.closeUpgradePanel();
    this.updateHUD();
  }

  // ── Wave management ────────────────────────────────
  private startNextWave() {
    // Interest mechanic: earn interest on unspent gold at wave start
    if (this.wave > 0) {
      const interest = Math.min(Math.floor(this.gold * INTEREST_RATE), INTEREST_CAP);
      this.gold += interest;

      // Wave completion bonus
      const waveBonus = 10 + this.wave * 2;
      this.gold += waveBonus;
      audio.play("wave_complete");
    }

    this.wave++;
    this.phase = "prep";
    this.prepTimer = this.wave === 1 ? 3 : 5;
    this.waveSpawns = generateWave(this.wave);
    this.waveSpawnIndex = 0;
    this.waveSpawnTimer = 0;
    this.updateHUD();
  }

  private startCombat() {
    this.phase = "combat";
    audio.play("wave_start");
    this.updateHUD();
  }

  // ── Click handler ──────────────────────────────────
  private handleClick(pointer: Phaser.Input.Pointer) {
    const col = Math.floor(pointer.x / this.map.tileSize);
    const row = Math.floor(pointer.y / this.map.tileSize);

    if (row < 0 || row >= this.map.rows || col < 0 || col >= this.map.cols) return;

    // Check if clicking an existing tower (for upgrade panel)
    const existingTower = this.towers.find((t) => t.pos.col === col && t.pos.row === row);
    if (existingTower) {
      this.showUpgradePanel(existingTower);
      return;
    }

    // Close upgrade panel when clicking elsewhere
    this.closeUpgradePanel();

    if (this.map.tiles[row][col] !== "buildable") return;

    const cfg = TOWER_CONFIGS[this.selectedTower];
    if (!cfg || this.gold < cfg.cost) return;

    this.gold -= cfg.cost;
    this.placeTower(this.selectedTower, { col, row });
    this.updateHUD();
  }

  private placeTower(kind: TowerKind, pos: TilePos) {
    const cfg = TOWER_CONFIGS[kind]!;
    const ts = this.map.tileSize;
    const cx = tileCenterX(pos.col, ts);
    const cy = tileCenterY(pos.row, ts);

    const color = COLORS[kind] ?? COLORS.arrow;
    const graphic = this.add.rectangle(cx, cy, ts - 4, ts - 4, color).setDepth(2);

    const rangeCircle = this.add
      .circle(cx, cy, cfg.range * ts, COLORS.range, 0.08)
      .setDepth(1)
      .setStrokeStyle(1, COLORS.range, 0.3);

    const tierLabel = this.add
      .text(cx + ts / 4, cy - ts / 4, "", {
        fontSize: "8px",
        color: "#ffffff",
        fontFamily: "monospace",
      })
      .setDepth(3)
      .setOrigin(0.5);

    this.towers.push({
      id: uid(),
      kind,
      config: cfg,
      pos,
      tier: 0,
      cooldown: 0,
      graphic,
      rangeCircle,
      tierLabel,
    });
    audio.play("tower_place");
  }

  // ── Spawn enemies ──────────────────────────────────
  private spawnEnemy(kind: EnemyKind) {
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg) return;

    const ts = this.map.tileSize;
    const startTile = this.map.path[0];
    const cx = tileCenterX(startTile.col, ts);
    const cy = tileCenterY(startTile.row, ts);

    const colorKey = `enemy_${kind}`;
    const color = COLORS[colorKey] ?? COLORS.enemy_basic;

    const radius = kind === "boss" ? ts / 2.2 : ts / 3;
    const graphic = this.add.circle(cx, cy, radius, color).setDepth(3);

    // Flying enemies get a ring indicator
    if (cfg.flying) {
      graphic.setStrokeStyle(2, 0xffffff, 0.6);
    }

    const hpBg = this.add.rectangle(cx, cy - ts / 2.5, ts - 4, 3, COLORS.hpBg).setDepth(4);
    const hpBar = this.add.rectangle(cx, cy - ts / 2.5, ts - 4, 3, COLORS.hpBar).setDepth(5);

    // Boss hp bar is wider and red-tinted
    if (kind === "boss") {
      hpBar.setFillStyle(0xff6600);
    }

    const enemy: Enemy = {
      id: uid(),
      kind,
      hp: cfg.hp,
      maxHp: cfg.hp,
      speed: cfg.speed,
      armor: cfg.armor,
      flying: cfg.flying,
      reward: cfg.reward,
      pathIndex: 0,
      worldPos: { x: cx, y: cy },
      graphic,
      hpBar,
      hpBg,
      slowFactor: 1,
      slowDuration: 0,
    };
    this.enemies.push(enemy);
    this.enemyIndex.set(enemy.id, enemy);
  }

  // ── Update loop ────────────────────────────────────
  update(_time: number, deltaMs: number) {
    const dt = deltaMs / 1000;
    if (this.phase === "gameover" || this.phase === "victory") return;

    if (this.phase === "prep") {
      this.prepTimer -= dt;
      if (this.prepTimer <= 0) {
        this.startCombat();
      }
      this.updateHUD();
      return;
    }

    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateTowers(dt);
    this.updateProjectiles(dt);

    // Check wave complete
    if (this.waveSpawnIndex >= this.waveSpawns.length && this.enemies.length === 0) {
      if (this.wave >= MAX_WAVES) {
        this.phase = "victory";
        audio.play("victory");
      } else {
        this.startNextWave();
      }
    }

    this.updateHUD();
  }

  private updateSpawning(dt: number) {
    if (this.waveSpawnIndex >= this.waveSpawns.length) return;

    this.waveSpawnTimer += dt * 1000;
    while (this.waveSpawnIndex < this.waveSpawns.length) {
      const spawn = this.waveSpawns[this.waveSpawnIndex];
      if (this.waveSpawnTimer < spawn.delay) break;
      this.spawnEnemy(spawn.kind);
      this.waveSpawnIndex++;
    }
  }

  private updateEnemies(dt: number) {
    const ts = this.map.tileSize;
    const path = this.map.path;
    const toRemove: string[] = [];

    for (const enemy of this.enemies) {
      // Update slow
      if (enemy.slowDuration > 0) {
        enemy.slowDuration -= dt;
        if (enemy.slowDuration <= 0) {
          enemy.slowFactor = 1;
          enemy.slowDuration = 0;
        }
      }

      const effectiveSpeed = enemy.speed * enemy.slowFactor;

      // Move along path
      const nextIdx = Math.floor(enemy.pathIndex) + 1;
      if (nextIdx >= path.length) {
        this.lives--;
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

      // Update graphics
      enemy.graphic.setPosition(enemy.worldPos.x, enemy.worldPos.y);
      // Tint slowed enemies blue
      if (enemy.slowFactor < 1) {
        enemy.graphic.setAlpha(0.7);
      } else {
        enemy.graphic.setAlpha(1);
      }
      enemy.hpBg.setPosition(enemy.worldPos.x, enemy.worldPos.y - ts / 2.5);
      const hpPct = enemy.hp / enemy.maxHp;
      const barWidth = (ts - 4) * hpPct;
      enemy.hpBar.setPosition(enemy.worldPos.x - ((ts - 4) - barWidth) / 2, enemy.worldPos.y - ts / 2.5);
      enemy.hpBar.setSize(barWidth, 3);
    }

    for (const id of toRemove) {
      this.removeEnemy(id);
    }

    if (this.lives <= 0) {
      this.lives = 0;
      this.phase = "gameover";
      audio.play("game_over");
    }
  }

  private updateTowers(dt: number) {
    const ts = this.map.tileSize;

    for (const tower of this.towers) {
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;

      const tcx = tileCenterX(tower.pos.col, ts);
      const tcy = tileCenterY(tower.pos.row, ts);
      const stats = effectiveStats(tower.config, tower.tier);
      const rangePx = stats.range * ts;

      // Find nearest enemy in range
      let target: Enemy | null = null;
      let minDist = Infinity;
      for (const enemy of this.enemies) {
        const d = dist({ x: tcx, y: tcy }, enemy.worldPos);
        if (d <= rangePx && d < minDist) {
          minDist = d;
          target = enemy;
        }
      }

      if (target) {
        this.fireProjectile(tower, target, { x: tcx, y: tcy });
        tower.cooldown = 1 / stats.fireRate;
      }
    }
  }

  private fireProjectile(tower: Tower, target: Enemy, from: WorldPos) {
    const stats = effectiveStats(tower.config, tower.tier);
    let projColor = COLORS.projectile;
    if (tower.kind === "frost") projColor = COLORS.projectile_frost;
    else if (tower.kind === "lightning") projColor = COLORS.projectile_lightning;

    const graphic = this.add.circle(from.x, from.y, 3, projColor).setDepth(6);

    const chainCount = tower.kind === "lightning" ? 2 + tower.tier : 0;

    this.projectiles.push({
      id: uid(),
      towerKind: tower.kind,
      damage: stats.damage,
      splash: stats.splash,
      speed: tower.kind === "lightning" ? 300 : 200,
      targetId: target.id,
      worldPos: { ...from },
      graphic,
      chainCount,
      chainHitIds: new Set(),
    });

    const sfxMap = { arrow: "shoot_arrow", cannon: "shoot_cannon", frost: "shoot_frost", lightning: "shoot_lightning", mortar: "shoot_mortar" } as const;
    audio.play(sfxMap[tower.kind]);
  }

  private updateProjectiles(dt: number) {
    const ts = this.map.tileSize;
    const toRemove: string[] = [];

    for (const proj of this.projectiles) {
      const target = this.enemyIndex.get(proj.targetId);
      if (!target) {
        toRemove.push(proj.id);
        continue;
      }

      const dx = target.worldPos.x - proj.worldPos.x;
      const dy = target.worldPos.y - proj.worldPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const moveAmount = proj.speed * dt;

      if (d <= moveAmount) {
        // Hit target
        proj.chainHitIds.add(target.id);

        if (proj.towerKind === "frost") {
          // Frost: damage + slow
          this.damageEnemy(target, proj.damage);
          target.slowFactor = 0.4;
          target.slowDuration = 2;
        } else if (proj.splash > 0) {
          // Splash damage (cannon, mortar)
          const splashPx = proj.splash * ts;
          for (const enemy of this.enemies) {
            if (dist(target.worldPos, enemy.worldPos) <= splashPx) {
              this.damageEnemy(enemy, proj.damage);
            }
          }
        } else {
          this.damageEnemy(target, proj.damage);
        }

        // Lightning chain
        if (proj.towerKind === "lightning" && proj.chainCount > 0) {
          const chainTarget = this.findChainTarget(target.worldPos, proj.chainHitIds, ts * 3);
          if (chainTarget) {
            proj.targetId = chainTarget.id;
            proj.chainCount--;
            proj.damage = Math.floor(proj.damage * 0.7); // 30% falloff per chain
            continue; // don't remove — retarget
          }
        }

        toRemove.push(proj.id);
      } else {
        proj.worldPos.x += (dx / d) * moveAmount;
        proj.worldPos.y += (dy / d) * moveAmount;
        proj.graphic.setPosition(proj.worldPos.x, proj.worldPos.y);
      }
    }

    for (const id of toRemove) {
      const idx = this.projectiles.findIndex((p) => p.id === id);
      if (idx !== -1) {
        this.projectiles[idx].graphic.destroy();
        this.projectiles.splice(idx, 1);
      }
    }
  }

  /** Find nearest enemy not already chained for lightning bounce */
  private findChainTarget(from: WorldPos, excludeIds: Set<string>, maxRange: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = maxRange;
    for (const enemy of this.enemies) {
      if (excludeIds.has(enemy.id)) continue;
      const d = dist(from, enemy.worldPos);
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    }
    return best;
  }

  private damageEnemy(enemy: Enemy, rawDamage: number) {
    const effectiveDamage = Math.max(1, rawDamage - enemy.armor);
    enemy.hp -= effectiveDamage;

    if (enemy.hp <= 0) {
      this.gold += enemy.reward;
      audio.play(enemy.kind === "boss" ? "boss_die" : "enemy_die");
      this.removeEnemy(enemy.id);
    }
  }

  private removeEnemy(id: string) {
    const idx = this.enemies.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const enemy = this.enemies[idx];
    enemy.graphic.destroy();
    enemy.hpBar.destroy();
    enemy.hpBg.destroy();
    this.enemies.splice(idx, 1);
    this.enemyIndex.delete(id);
  }
}
