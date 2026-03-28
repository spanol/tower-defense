/**
 * Multiplayer Tower Defense — WebSocket + HTTP server.
 * Handles lobby, rooms, relays game state, and serves REST API
 * for player profiles, match history, and analytics.
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { decode } from "@msgpack/msgpack";
import type {
  PlayerId,
  ClientMessage,
  ServerMessage,
} from "@td/shared";
import { GameRoom, type SendFn } from "./game-room.js";
import { handleHttpRequest } from "./api.js";
import { playerDb, matchDb, analyticsDb } from "./db.js";

const PORT = parseInt(process.env.TD_PORT ?? "3001", 10);

// ── Connection tracking ────────────────────────────────

interface Connection {
  ws: WebSocket;
  playerId: PlayerId;
  playerName: string;
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

// Track game start times per room for match recording
const roomStartTimes = new Map<string, number>();

/** Record a completed match to the database */
function recordMatch(room: GameRoom, result: "victory" | "defeat" | "disconnect"): void {
  const info = room.getRoomInfo();
  const startedAt = roomStartTimes.get(room.id) ?? Date.now();
  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;
  const playerIds = info.players.map((p) => p.id);

  // Ensure all players exist in the DB
  for (const p of info.players) {
    const conn = connections.get(p.id);
    const name = conn?.playerName ?? p.name;
    playerDb.upsert(p.id, name);
  }

  const matchId = uuid();
  const state = room.buildFullState();
  matchDb.record(
    matchId,
    info.mode,
    info.mapKey,
    state.wave,
    state.score,
    result,
    durationMs,
    startedAt,
    finishedAt,
    playerIds,
  );

  analyticsDb.track("match_complete", undefined, matchId, {
    mode: info.mode,
    map: info.mapKey,
    result,
    waves: state.wave,
    score: state.score,
    players: info.players.length,
    durationMs,
  });

  roomStartTimes.delete(room.id);
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
      conn.playerName = msg.playerName;
      playerDb.upsert(conn.playerId, msg.playerName);

      const room = new GameRoom(
        conn.playerId,
        msg.playerName,
        msg.mode,
        msg.mapKey,
        makeSendFn(),
        (r, result) => recordMatch(r, result),
      );
      rooms.set(room.id, room);
      roomsByCode.set(room.code, room);
      conn.roomId = room.id;

      analyticsDb.track("room_created", conn.playerId, undefined, {
        mode: msg.mode,
        map: msg.mapKey,
      });

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
      conn.playerName = msg.playerName;
      playerDb.upsert(conn.playerId, msg.playerName);

      analyticsDb.track("room_joined", conn.playerId);

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
          roomStartTimes.set(room.id, Date.now());
          analyticsDb.track("game_started", conn.playerId, undefined, {
            mode: room.getRoomInfo().mode,
            map: room.getRoomInfo().mapKey,
            players: room.getRoomInfo().players.length,
          });
        }
      }, 3000);
      break;
    }

    case "place_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handlePlaceTower(conn.playerId, msg);
      analyticsDb.track("tower_placed", conn.playerId, undefined, { kind: msg.kind });
      break;
    }

    case "upgrade_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handleUpgradeTower(conn.playerId, msg);
      analyticsDb.track("tower_upgraded", conn.playerId);
      break;
    }

    case "sell_tower": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handleSellTower(conn.playerId, msg);
      break;
    }

    case "send_attack": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room || room.getStatus() !== "playing") return;
      room.handleSendAttack(conn.playerId, msg);
      break;
    }

    case "chat": {
      const room = conn.roomId ? rooms.get(conn.roomId) : null;
      if (!room) return;
      const text = msg.text.slice(0, 200);
      broadcastToRoom(room, {
        type: "chat",
        playerId: conn.playerId,
        playerName: conn.playerName,
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

// ── HTTP + WebSocket server ───────────────────────────

const httpServer = createServer(async (req, res) => {
  const handled = await handleHttpRequest(req, res);
  if (!handled) {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws: WebSocket) => {
  const playerId = uuid();
  const conn: Connection = { ws, playerId, playerName: `Player${Math.floor(Math.random() * 9999)}`, roomId: null };
  connections.set(playerId, conn);

  analyticsDb.track("player_connected", playerId);

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
    analyticsDb.track("player_disconnected", playerId);
    leaveRoom(conn);
    connections.delete(playerId);
  });

  ws.on("error", () => {
    leaveRoom(conn);
    connections.delete(playerId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Tower Defense server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  REST API:  http://localhost:${PORT}/api/`);
});
