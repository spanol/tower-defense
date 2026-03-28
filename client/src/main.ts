import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene.js";
import { MenuScene } from "./scenes/MenuScene.js";
import { LobbyScene } from "./scenes/LobbyScene.js";
import { MultiplayerGameScene } from "./scenes/MultiplayerGameScene.js";

let game: Phaser.Game | null = null;

const landing = document.getElementById("landing")!;
const gameContainer = document.getElementById("game-container")!;
const backBtn = document.getElementById("back-to-landing")!;
const playBtn = document.getElementById("play-now-btn")!;

function startGame() {
  landing.classList.add("hidden");
  gameContainer.classList.add("active");
  backBtn.classList.add("active");

  if (!game) {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      width: 480,
      height: 320,
      parent: gameContainer,
      backgroundColor: "#1a1a2e",
      pixelArt: true,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [MenuScene, GameScene, LobbyScene, MultiplayerGameScene],
    });
  }
}

function showLanding() {
  if (game) {
    game.destroy(true);
    game = null;
  }
  gameContainer.classList.remove("active");
  backBtn.classList.remove("active");
  landing.classList.remove("hidden");
  window.scrollTo(0, 0);
}

playBtn.addEventListener("click", startGame);
backBtn.addEventListener("click", showLanding);
