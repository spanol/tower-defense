import Phaser from "phaser";
import { MAPS, MAP_KEYS } from "@td/shared";

export class MenuScene extends Phaser.Scene {
  private selectedMap = 0;

  constructor() {
    super({ key: "MenuScene" });
  }

  create() {
    this.selectedMap = 0;
    const cx = this.cameras.main.centerX;
    const cy = this.cameras.main.centerY;

    this.add
      .text(cx, cy - 60, "TOWER DEFENSE", {
        fontSize: "24px",
        color: "#ffffff",
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    // Map selector
    this.add
      .text(cx, cy - 20, "Select Map:", {
        fontSize: "12px",
        color: "#aaaaaa",
        fontFamily: "monospace",
      })
      .setOrigin(0.5);

    const mapButtons: Phaser.GameObjects.Text[] = [];
    MAP_KEYS.forEach((key, i) => {
      const map = MAPS[key];
      const btn = this.add
        .text(cx, cy + 5 + i * 22, `[ ${map.name} ]`, {
          fontSize: "13px",
          color: i === 0 ? "#ffffff" : "#888888",
          fontFamily: "monospace",
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      btn.on("pointerdown", () => {
        this.selectedMap = i;
        mapButtons.forEach((b, j) => b.setColor(j === i ? "#ffffff" : "#888888"));
      });
      mapButtons.push(btn);
    });

    const playBtn = this.add
      .text(cx, cy + 5 + MAP_KEYS.length * 22 + 15, "[ PLAY SOLO ]", {
        fontSize: "16px",
        color: "#44ff44",
        fontFamily: "monospace",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    playBtn.on("pointerdown", () => {
      this.scene.start("GameScene", { mapKey: MAP_KEYS[this.selectedMap] });
    });

    const multiBtn = this.add
      .text(cx, cy + 5 + MAP_KEYS.length * 22 + 40, "[ MULTIPLAYER ]", {
        fontSize: "16px",
        color: "#44aaff",
        fontFamily: "monospace",
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    multiBtn.on("pointerdown", () => {
      this.scene.start("LobbyScene");
    });
  }
}
