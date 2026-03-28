import Phaser from "phaser";
import {
  MAPS,
  DEFAULT_MAP,
  TOWER_CONFIGS,
  ENEMY_CONFIGS,
  type GameMap,
  type TilePos,
  type WorldPos,
  type TowerKind,
  type EnemyKind,
  type TowerConfig,
} from "@td/shared";

// ── Color palette ──────────────────────────────────────
const COLORS = {
  path: 0x8b7355,
  buildable: 0x228b22,
  blocked: 0x2d2d2d,
  start: 0x4488ff,
  end: 0xff4444,
  arrow: 0xffcc00,
  cannon: 0xff6600,
  enemy_basic: 0xff0000,
  enemy_fast: 0xff66ff,
  enemy_armored: 0x888888,
  projectile: 0xffffff,
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
  damage: number;
  splash: number;
  speed: number;
  targetId: string;
  worldPos: WorldPos;
  graphic: Phaser.GameObjects.Arc;
}

// ── Wave generation ────────────────────────────────────
function generateWave(waveNum: number): { kind: EnemyKind; delay: number }[] {
  const budget = 50 + waveNum * 30;
  const isBoss = waveNum % 5 === 0;
  const enemies: { kind: EnemyKind; delay: number }[] = [];

  if (isBoss) {
    // Boss wave: armored heavy units
    const count = Math.max(1, Math.floor(budget / ENEMY_CONFIGS.armored.waveBudgetCost));
    for (let i = 0; i < count; i++) {
      enemies.push({ kind: "armored", delay: i * 800 });
    }
    return enemies;
  }

  let remaining = budget;
  let idx = 0;
  const kinds: EnemyKind[] = ["basic", "fast"];
  if (waveNum >= 3) kinds.push("armored");

  while (remaining > 0) {
    const kind = kinds[idx % kinds.length];
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg || cfg.waveBudgetCost > remaining) break;
    remaining -= cfg.waveBudgetCost;
    enemies.push({ kind, delay: idx * 600 });
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

// ── GameScene ──────────────────────────────────────────
export class GameScene extends Phaser.Scene {
  private map!: GameMap;
  private towers: Tower[] = [];
  private enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];

  private gold = 200;
  private lives = 20;
  private wave = 0;
  private phase: "prep" | "combat" | "gameover" | "victory" = "prep";
  private prepTimer = 5;
  private selectedTower: TowerKind = "arrow";

  private waveSpawns: { kind: EnemyKind; delay: number }[] = [];
  private waveSpawnTimer = 0;
  private waveSpawnIndex = 0;

  // HUD text
  private goldText!: Phaser.GameObjects.Text;
  private livesText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private towerPickerTexts: Phaser.GameObjects.Text[] = [];

  constructor() {
    super({ key: "GameScene" });
  }

  create() {
    this.map = MAPS[DEFAULT_MAP];
    this.towers = [];
    this.enemies = [];
    this.projectiles = [];
    this.gold = 200;
    this.lives = 20;
    this.wave = 0;
    this.phase = "prep";
    this.prepTimer = 5;
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
    this.livesText = this.add.text(100, 2, "", style).setDepth(10);
    this.waveText = this.add.text(200, 2, "", style).setDepth(10);
    this.phaseText = this.add.text(300, 2, "", style).setDepth(10);

    // Tower picker at bottom
    const towerKinds: TowerKind[] = ["arrow", "cannon"];
    towerKinds.forEach((kind, i) => {
      const cfg = TOWER_CONFIGS[kind];
      const txt = this.add
        .text(4 + i * 120, this.map.rows * this.map.tileSize - 16, `[${cfg.name} $${cfg.cost}]`, {
          fontSize: "10px",
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
        this.updateHUD();
      });
      this.towerPickerTexts.push(txt);
    });

    this.updateHUD();
  }

  private updateHUD() {
    this.goldText.setText(`Gold: ${this.gold}`);
    this.livesText.setText(`Lives: ${this.lives}`);
    this.waveText.setText(`Wave: ${this.wave}`);

    if (this.phase === "prep") {
      this.phaseText.setText(`Prep: ${Math.ceil(this.prepTimer)}s`);
    } else if (this.phase === "combat") {
      this.phaseText.setText(`Enemies: ${this.enemies.length}`);
    } else if (this.phase === "gameover") {
      this.phaseText.setText("GAME OVER");
    } else if (this.phase === "victory") {
      this.phaseText.setText("VICTORY!");
    }

    // Highlight selected tower
    const kinds: TowerKind[] = ["arrow", "cannon"];
    kinds.forEach((k, i) => {
      const txt = this.towerPickerTexts[i];
      if (txt) {
        txt.setColor(k === this.selectedTower ? "#ffffff" : "#ffcc00");
      }
    });
  }

  // ── Wave management ────────────────────────────────
  private startNextWave() {
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
    this.updateHUD();
  }

  // ── Click handler (place towers) ───────────────────
  private handleClick(pointer: Phaser.Input.Pointer) {
    const col = Math.floor(pointer.x / this.map.tileSize);
    const row = Math.floor(pointer.y / this.map.tileSize);

    if (row < 0 || row >= this.map.rows || col < 0 || col >= this.map.cols) return;
    if (this.map.tiles[row][col] !== "buildable") return;
    if (this.towers.some((t) => t.pos.col === col && t.pos.row === row)) return;

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

    const color = kind === "arrow" ? COLORS.arrow : COLORS.cannon;
    const graphic = this.add.rectangle(cx, cy, ts - 4, ts - 4, color).setDepth(2);

    const rangeCircle = this.add
      .circle(cx, cy, cfg.range * ts, COLORS.range, 0.08)
      .setDepth(1)
      .setStrokeStyle(1, COLORS.range, 0.3);

    this.towers.push({
      id: uid(),
      kind,
      config: cfg,
      pos,
      tier: 0,
      cooldown: 0,
      graphic,
      rangeCircle,
    });
  }

  // ── Spawn enemies ──────────────────────────────────
  private spawnEnemy(kind: EnemyKind) {
    const cfg = ENEMY_CONFIGS[kind];
    if (!cfg) return;

    const ts = this.map.tileSize;
    const startTile = this.map.path[0];
    const cx = tileCenterX(startTile.col, ts);
    const cy = tileCenterY(startTile.row, ts);

    const color =
      kind === "fast" ? COLORS.enemy_fast : kind === "armored" ? COLORS.enemy_armored : COLORS.enemy_basic;

    const graphic = this.add.circle(cx, cy, ts / 3, color).setDepth(3);
    const hpBg = this.add.rectangle(cx, cy - ts / 2.5, ts - 4, 3, COLORS.hpBg).setDepth(4);
    const hpBar = this.add.rectangle(cx, cy - ts / 2.5, ts - 4, 3, COLORS.hpBar).setDepth(5);

    this.enemies.push({
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
    });
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

    // Spawn enemies
    this.updateSpawning(dt);

    // Move enemies
    this.updateEnemies(dt);

    // Tower targeting & firing
    this.updateTowers(dt);

    // Move projectiles
    this.updateProjectiles(dt);

    // Check wave complete
    if (this.waveSpawnIndex >= this.waveSpawns.length && this.enemies.length === 0) {
      if (this.wave >= 20) {
        this.phase = "victory";
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
      const effectiveSpeed = enemy.speed * enemy.slowFactor;
      if (enemy.slowDuration > 0) {
        enemy.slowDuration -= dt;
        if (enemy.slowDuration <= 0) {
          enemy.slowFactor = 1;
          enemy.slowDuration = 0;
        }
      }

      // Move along path
      const nextIdx = Math.floor(enemy.pathIndex) + 1;
      if (nextIdx >= path.length) {
        // Reached end
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
    }
  }

  private updateTowers(dt: number) {
    const ts = this.map.tileSize;

    for (const tower of this.towers) {
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;

      const tcx = tileCenterX(tower.pos.col, ts);
      const tcy = tileCenterY(tower.pos.row, ts);
      const rangePx = tower.config.range * ts;

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
        tower.cooldown = 1 / tower.config.fireRate;
      }
    }
  }

  private fireProjectile(tower: Tower, target: Enemy, from: WorldPos) {
    const graphic = this.add.circle(from.x, from.y, 3, COLORS.projectile).setDepth(6);

    this.projectiles.push({
      id: uid(),
      damage: tower.config.damage,
      splash: tower.config.splash,
      speed: 200,
      targetId: target.id,
      worldPos: { ...from },
      graphic,
    });
  }

  private updateProjectiles(dt: number) {
    const ts = this.map.tileSize;
    const toRemove: string[] = [];

    for (const proj of this.projectiles) {
      const target = this.enemies.find((e) => e.id === proj.targetId);
      if (!target) {
        toRemove.push(proj.id);
        continue;
      }

      const dx = target.worldPos.x - proj.worldPos.x;
      const dy = target.worldPos.y - proj.worldPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const moveAmount = proj.speed * dt;

      if (d <= moveAmount) {
        // Hit
        if (proj.splash > 0) {
          const splashPx = proj.splash * ts;
          for (const enemy of this.enemies) {
            if (dist(target.worldPos, enemy.worldPos) <= splashPx) {
              this.damageEnemy(enemy, proj.damage);
            }
          }
        } else {
          this.damageEnemy(target, proj.damage);
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

  private damageEnemy(enemy: Enemy, rawDamage: number) {
    const effectiveDamage = Math.max(1, rawDamage - enemy.armor);
    enemy.hp -= effectiveDamage;

    if (enemy.hp <= 0) {
      this.gold += enemy.reward;
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
  }
}
