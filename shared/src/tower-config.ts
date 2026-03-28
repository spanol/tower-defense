import type { TowerConfig } from "./types.js";

export const TOWER_CONFIGS: Record<string, TowerConfig> = {
  arrow: {
    kind: "arrow",
    name: "Arrow Tower",
    cost: 50,
    damage: 10,
    range: 3,
    fireRate: 2,
    splash: 0,
    special: null,
    upgrades: [
      { tier: 1, cost: 40, damageMultiplier: 1.5, rangeMultiplier: 1, fireRateMultiplier: 1.2, specialization: null },
      { tier: 2, cost: 80, damageMultiplier: 2, rangeMultiplier: 1.2, fireRateMultiplier: 1.4, specialization: null },
      { tier: 3, cost: 160, damageMultiplier: 3, rangeMultiplier: 1.5, fireRateMultiplier: 1.6, specialization: "Sniper" },
    ],
  },
  cannon: {
    kind: "cannon",
    name: "Cannon Tower",
    cost: 80,
    damage: 30,
    range: 2,
    fireRate: 0.8,
    splash: 1.5,
    special: "Splash damage",
    upgrades: [
      { tier: 1, cost: 60, damageMultiplier: 1.5, rangeMultiplier: 1, fireRateMultiplier: 1.1, specialization: null },
      { tier: 2, cost: 120, damageMultiplier: 2, rangeMultiplier: 1.1, fireRateMultiplier: 1.2, specialization: null },
      { tier: 3, cost: 240, damageMultiplier: 3, rangeMultiplier: 1.2, fireRateMultiplier: 1.3, specialization: "Siege Cannon" },
    ],
  },
};
