# Multiplayer Tower Defense

Real-time cooperative/competitive tower defense game running in the browser.

## Setup

```bash
pnpm install
```

## Running (Development)

```bash
# Terminal 1 — game server (WebSocket + REST API on port 3001)
pnpm dev:server

# Terminal 2 — client dev server (Vite on port 3000)
pnpm dev
```

## Running (Production / Docker)

```bash
docker compose up --build
```

Client is served on port 80 via nginx. The nginx config proxies `/api/` and `/ws` to the server container.

## Playing

- Open the landing page at `http://localhost:3000` (dev) or `http://localhost` (docker)
- Click **Play Now** to launch the game
- **Solo mode**: Select a map → "PLAY SOLO"
- **Multiplayer**: "MULTIPLAYER" → create/join room by 4-char code
  - Co-op: shared economy, 2-4 players
  - Versus: per-player lanes, attack tokens

## Project Structure

- `client/` — Phaser 3 game client (TS + Vite) with landing page
- `server/` — WebSocket + HTTP server with REST API, SQLite persistence
- `shared/` — Types, configs, maps, protocol definitions

## Architecture

### Server

- Authoritative simulation at 20 ticks/sec
- JSON for lobby, MessagePack for game state
- Room system with 4-char codes, max 4 players
- Delta compression + 5-sec full snapshots
- 30-sec reconnection grace period
- SQLite for player profiles, match history, and analytics
- REST API: `/api/players`, `/api/leaderboard`, `/api/analytics`

### Client

- Phaser 3 renderer with procedural audio
- Landing page with hero, features, and game modes
- Thin client: commands only, server-authoritative
- Client prediction for tower placement
- Auto-reconnect support

### Deployment

- Docker Compose: nginx (client) + Node.js (server)
- SQLite data persisted via Docker volume
- Nginx proxies API and WebSocket traffic to server

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/players` | Register/upsert a player |
| GET | `/api/players/:id` | Get player stats |
| GET | `/api/players/:id/matches` | Get match history |
| GET | `/api/leaderboard` | Top 20 players by score |
| GET | `/api/analytics/events` | Event counts (last 7 days) |
| GET | `/api/analytics/metrics` | Aggregate game metrics |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TD_PORT` | `3001` | Server listen port |
| `TD_DB_PATH` | `./td.sqlite` | SQLite database path |
