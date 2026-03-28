/**
 * LobbyScene — multiplayer lobby for creating/joining rooms.
 * Players can create a room (pick mode + map) or join via room code.
 */

import Phaser from "phaser";
import { MAPS, MAP_KEYS, type GameMode, type RoomInfo, type ServerMessage } from "@td/shared";
import { net } from "../network.js";

export class LobbyScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private roomInfoTexts: Phaser.GameObjects.Text[] = [];
  private currentRoom: RoomInfo | null = null;
  private playerName = `Player${Math.floor(Math.random() * 9999)}`;
  private selectedMap = 0;

  constructor() {
    super({ key: "LobbyScene" });
  }

  create() {
    this.currentRoom = null;
    this.roomInfoTexts = [];

    const cx = this.cameras.main.centerX;
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: "11px",
      color: "#ffffff",
      fontFamily: "monospace",
    };

    this.add.text(cx, 15, "MULTIPLAYER LOBBY", { ...style, fontSize: "18px" }).setOrigin(0.5);

    // Connect to server
    this.statusText = this.add.text(cx, 40, "Connecting...", { ...style, color: "#ffaa00" }).setOrigin(0.5);

    net.onMessage((msg) => this.handleServerMessage(msg as ServerMessage));
    net.connect()
      .then(() => {
        this.statusText.setText("Connected. Create or join a room.");
        this.showLobbyUI();
      })
      .catch(() => {
        this.statusText.setText("Failed to connect. Is server running?");
      });
  }

  private showLobbyUI(): void {
    const cx = this.cameras.main.centerX;
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: "10px",
      color: "#ffffff",
      fontFamily: "monospace",
    };

    // Map selector
    this.add.text(cx, 65, "Map:", style).setOrigin(0.5);
    MAP_KEYS.forEach((key, i) => {
      const map = MAPS[key];
      const btn = this.add
        .text(cx - 80 + i * 80, 82, `[${map.name}]`, {
          ...style,
          color: i === 0 ? "#ffffff" : "#888888",
          fontSize: "9px",
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });

      btn.on("pointerdown", () => {
        this.selectedMap = i;
        this.children.each((child) => {
          if (child instanceof Phaser.GameObjects.Text && child.y === 82) {
            child.setColor("#888888");
          }
        });
        btn.setColor("#ffffff");
      });
    });

    // Create Co-op button
    const createCoopBtn = this.add
      .text(cx - 70, 115, "[ Create Co-op ]", { ...style, color: "#44ff44", fontSize: "12px" })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    createCoopBtn.on("pointerdown", () => {
      net.send({
        type: "create_room",
        playerName: this.playerName,
        mode: "coop",
        mapKey: MAP_KEYS[this.selectedMap],
      });
    });

    // Create Versus button
    const createVsBtn = this.add
      .text(cx + 70, 115, "[ Create Versus ]", { ...style, color: "#ff8844", fontSize: "12px" })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    createVsBtn.on("pointerdown", () => {
      net.send({
        type: "create_room",
        playerName: this.playerName,
        mode: "versus",
        mapKey: MAP_KEYS[this.selectedMap],
      });
    });

    // Join by code
    this.add.text(cx, 150, "—— or join by code ——", { ...style, color: "#888888" }).setOrigin(0.5);

    let joinCode = "";
    const codeText = this.add.text(cx, 175, "Code: ____", { ...style, fontSize: "14px" }).setOrigin(0.5);

    this.input.keyboard!.on("keydown", (event: KeyboardEvent) => {
      if (this.currentRoom) return; // Already in room
      if (event.key === "Backspace" && joinCode.length > 0) {
        joinCode = joinCode.slice(0, -1);
      } else if (event.key.length === 1 && joinCode.length < 4) {
        joinCode += event.key.toUpperCase();
      }
      const display = joinCode.padEnd(4, "_");
      codeText.setText(`Code: ${display}`);

      if (joinCode.length === 4) {
        net.send({ type: "join_room", playerName: this.playerName, roomCode: joinCode });
        joinCode = "";
      }
    });

    // Back button
    const backBtn = this.add
      .text(30, 300, "[ Back ]", { ...style, color: "#ff4444" })
      .setInteractive({ useHandCursor: true });

    backBtn.on("pointerdown", () => {
      net.disconnect();
      this.scene.start("MenuScene");
    });
  }

  private showRoomUI(): void {
    if (!this.currentRoom) return;

    // Clear dynamic texts
    for (const t of this.roomInfoTexts) t.destroy();
    this.roomInfoTexts = [];

    const cx = this.cameras.main.centerX;
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: "10px",
      color: "#ffffff",
      fontFamily: "monospace",
    };

    const room = this.currentRoom;
    const modeLabel = room.mode === "coop" ? "CO-OP" : "VERSUS";

    const t1 = this.add.text(cx, 200, `Room: ${room.code}  |  ${modeLabel}  |  ${MAPS[room.mapKey]?.name ?? room.mapKey}`, style).setOrigin(0.5);
    this.roomInfoTexts.push(t1);

    room.players.forEach((p, i) => {
      const readyMark = p.ready ? " [READY]" : "";
      const hostMark = p.id === room.hostId ? " (host)" : "";
      const t = this.add.text(cx, 220 + i * 16, `${p.name}${hostMark}${readyMark}`, { ...style, color: "#aaffaa" }).setOrigin(0.5);
      this.roomInfoTexts.push(t);
    });

    // Ready button
    const readyBtn = this.add
      .text(cx - 60, 290, "[ Ready ]", { ...style, color: "#44ff44", fontSize: "12px" })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.roomInfoTexts.push(readyBtn);

    readyBtn.on("pointerdown", () => {
      net.send({ type: "set_ready", ready: true });
    });

    // Start button (host only)
    const startBtn = this.add
      .text(cx + 60, 290, "[ Start ]", { ...style, color: "#ffcc00", fontSize: "12px" })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.roomInfoTexts.push(startBtn);

    startBtn.on("pointerdown", () => {
      net.send({ type: "start_game" });
    });
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "room_created":
      case "room_joined":
        this.currentRoom = msg.room;
        if (msg.type === "room_joined") {
          this.statusText.setText(`Joined room ${msg.room.code}`);
        } else {
          this.statusText.setText(`Room created: ${msg.room.code}`);
        }
        this.showRoomUI();
        break;

      case "room_updated":
        this.currentRoom = msg.room;
        this.showRoomUI();
        break;

      case "game_starting":
        this.statusText.setText(`Game starting in ${msg.countdown}s...`);
        break;

      case "game_state":
        // Full state received — transition to game
        this.scene.start("MultiplayerGameScene", {
          mapKey: this.currentRoom?.mapKey ?? "forest",
          mode: this.currentRoom?.mode ?? "coop",
          initialState: msg,
        });
        break;

      case "error":
        this.statusText.setText(`Error: ${msg.message}`);
        break;

      default:
        break;
    }
  }
}
