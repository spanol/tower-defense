/**
 * Multiplayer Tower Defense — WebSocket server.
 * Handles lobby, rooms, and relays game state from GameRoom instances.
 */

import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { decode } from "@msgpack/msgpack";
import type {
  PlayerId,
  ClientMessage,
  ServerMessage,
} from "@td/shared";
import { GameRoom, type SendFn } from "./game-room.js";

const PORT = parseInt(process.env.TD_PORT ?? "3001", 10);

// ── Connection tracking ────────────────────────────────

interface Connection {
  ws: WebSocket;
  playerId: PlayerId;
  roomId: string | null;
}

const connections = new Map<PlayerId, Connection>();
const rooms = new Map<string, GameRoom>();
const roomsByCode = new Map<string, GameRoom>();

// ── Send helpers ───────────────────────────────────────

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendBinary(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

/** SendFn factory for GameRoom — routes to correct WebSocket */
const makeSendFn = (): SendFn => {
  return (playerId: PlayerId, msg: ServerMessage | Uint8Array) => {
    const conn = connections.get(playerId);
    if (!conn) return;
    if (msg instanceof Uint8Array) {
      sendBinary(conn.ws, msg);
    } else {
      sendJson(conn.ws, msg);
    }
  };
};

// ── Room management ────────────────────────────────────

function findRoomByCode(code: string): GameRoom | undefined {
  return roomsByCode.get(code.toUpperCase());
}

function destroyRoom(room: GameRoom): void {
  room.stop();
  rooms.delete(room.id);
  roomsByCode.delete(room.code);
}

// Periodic cleanup of disconnected players past grace period
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.cleanupDisconnected()) {
      destroyRoom(room);
    }
  }
}, 5000);

// ── Message handler ────────────────────────────────────

function handleMessage(conn: Connection, msg: ClientMessage): void {
  switch (msg.type) {
    case "create_room": {
      if (conn.roomId) {
        sendJson(conn.ws, { type: "error", message: "Already in a room" });
        return;
      }
      const room = new GameRoom(
        conn.playerId,
        msg.playerName,
        msg.mode,
        msg.mapKey,
        makeSendFn(),
      );
      rooms.set(room.id, room);
      roomsByCode.set(room.code, room);
      conn.roomId = room.id;

      sendJson(conn.ws, { type: "room_created", room: room.getRoomInfo() });
      break;
    }

    case "join_room": {
      if (conn.roomId) {
        sendJson(conn.ws, { type: "error", message: "Already in a room" });
        return;
      }
      const room = findRoomByCode(msg.roomCode);
      if (!room) {
        sendJson(conn.ws, { type: "error", message: "Room not found" });
        return;
      }
      if (!room.addPlayer(conn.playerId, msg.playerName)) {
        sendJson(conn.ws, { type: "error", message: "Room is full or game in progress" });
        return;
      }
      conn.roomId = room.id;

      sendJson(conn.ws, {
        type: "room_joined",
        room: room.getRoomInfo(),
        playerId: conn.playerId,
      });

      // Notify other players
      broadcastRoomUpdate(room, conn.playerId);

      // If reconnecting mid-game, send full state
      if (room.getStatus() === "playing") {
        const state = room.buildFullState();
        sendJson(conn.ws, state);
      }
      break;
    }

    case "leave_room": {
      leaveRoom(conn);
      sendJson(conn.ws, { type: "room_left" });
      break;
    }

    case "set_ready": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room) return;
      room.setReady(conn.playerId, msg.ready);
      broadcastRoomUpdate(room);
      break;
    }

    case "start_game": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room) return;
      if (!room.canStart(conn.playerId)) {
        sendJson(conn.ws, { type: "error", message: "Cannot start game" });
        return;
      }

      // Countdown
      broadcastToRoom(room, { type: "game_starting", countdown: 3 });
      setTimeout(() => {
        if (room.getStatus() === "waiting") {
          room.startGame();
        }
      }, 3000);
      break;
    }

    case "place_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handlePlaceTower(conn.playerId, msg);
      break;
    }

    case "upgrade_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handleUpgradeTower(conn.playerId, msg);
      break;
    }

    case "sell_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handleSellTower(conn.playerId, msg);
      break;
    }

    case "chat": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room) return;
      const text = msg.text.slice(0, 200); // limit chat length
      broadcastToRoom(room, {
        type: "chat",
        playerId: conn.playerId,
        playerName: "Player", // TODO: store name on connection
        text,
      });
      break;
    }

    case "ping": {
      sendJson(conn.ws, { type: "pong", t: msg.t, serverTime: Date.now() });
      break;
    }

    default:
      sendJson(conn.ws, { type: "error", message: "Unknown message type" });
  }
}

function leaveRoom(conn: Connection): void {
  if (!conn.roomId) return;
  const room = rooms.get(conn.roomId);
  conn.roomId = null;
  if (!room) return;

  const empty = room.removePlayer(conn.playerId);
  if (empty) {
    destroyRoom(room);
  } else {
    broadcastRoomUpdate(room);
  }
}

function broadcastRoomUpdate(room: GameRoom, excludeId?: PlayerId): void {
  const info = room.getRoomInfo();
  for (const player of info.players) {
    if (player.id === excludeId) continue;
    const c = connections.get(player.id);
    if (c) sendJson(c.ws, { type: "room_updated", room: info });
  }
}

function broadcastToRoom(room: GameRoom, msg: ServerMessage): void {
  const info = room.getRoomInfo();
  for (const player of info.players) {
    const c = connections.get(player.id);
    if (c) sendJson(c.ws, msg);
  }
}

// ── WebSocket server ───────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket) => {
  const playerId = uuid();
  const conn: Connection = { ws, playerId, roomId: null };
  connections.set(playerId, conn);

  // Send player their ID
  sendJson(ws, { type: "room_left" } as ServerMessage); // noop ack
  // We'll rely on room_created/room_joined to convey playerId

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      // Try JSON first (lobby messages), fall back to msgpack
      const str = data.toString("utf-8");
      const msg = JSON.parse(str) as ClientMessage;
      handleMessage(conn, msg);
    } catch {
      // Binary message — shouldn't happen from client in current design
    }
  });

  ws.on("close", () => {
    leaveRoom(conn);
    connections.delete(playerId);
  });

  ws.on("error", () => {
    leaveRoom(conn);
    connections.delete(playerId);
  });
});

console.log(`Tower Defense server listening on ws://localhost:${PORT}`);
