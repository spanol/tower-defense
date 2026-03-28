import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene.js";
import { MenuScene } from "./scenes/MenuScene.js";
import { LobbyScene } from "./scenes/LobbyScene.js";
import { MultiplayerGameScene } from "./scenes/MultiplayerGameScene.js";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 480, // 15 cols * 32px
  height: 320, // 10 rows * 32px
  parent: document.body,
  backgroundColor: "#1a1a2e",
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MenuScene, GameScene, LobbyScene, MultiplayerGameScene],
};

new Phaser.Game(config);
