# Multiplayer Tower Defense

Real-time cooperative/competitive tower defense game running in the browser.

## Setup

```bash
pnpm install
```

## Running

```bash
# Terminal 1 — game server (WebSocket on port 3001)
pnpm dev:server

# Terminal 2 — client dev server (Vite on port 5173)
pnpm dev
```

## Playing

- **Solo mode**: Select a map from the menu and click "PLAY SOLO"
- **Multiplayer**: Click "MULTIPLAYER" → create or join a room by 4-char code
  - Co-op: shared map, shared economy, 2-4 players
  - Versus: attack token mechanic (Phase 4)

## Project Structure

- `client/` — Phaser 3 game client (TypeScript + Vite)
- `server/` — WebSocket game server with authoritative state
- `shared/` — Shared types, tower/enemy configs, map data, network protocol

## Architecture

### Server
- Authoritative game simulation at 20 ticks/sec
- WebSocket transport: JSON for lobby/chat, MessagePack for game state
- Room/lobby system with 4-char join codes, up to 4 players per room
- Delta compression: only changed entities sent each tick
- Full state snapshots every 5 seconds for resync
- 30-second reconnection grace window

### Client
- Phaser 3 rendering engine
- Thin client: sends commands, renders server state
- Client prediction for tower placement (server confirms/rejects)
- Automatic reconnection on disconnect

## Current Status

Phase 3: Multiplayer infrastructure (WebSocket server, lobby, co-op mode, state sync).
