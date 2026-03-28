import type { EnemyConfig } from "./types.js";

export const ENEMY_CONFIGS: Record<string, EnemyConfig> = {
  basic: {
    kind: "basic",
    name: "Grunt",
    hp: 50,
    speed: 1.5,
    reward: 10,
    armor: 0,
    flying: false,
    waveBudgetCost: 10,
  },
  fast: {
    kind: "fast",
    name: "Runner",
    hp: 30,
    speed: 3,
    reward: 15,
    armor: 0,
    flying: false,
    waveBudgetCost: 15,
  },
  armored: {
    kind: "armored",
    name: "Heavy",
    hp: 120,
    speed: 0.8,
    reward: 25,
    armor: 5,
    flying: false,
    waveBudgetCost: 25,
  },
};
