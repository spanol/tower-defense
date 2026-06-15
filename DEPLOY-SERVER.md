# Deploying the multiplayer game server (SPA-37)

The solo game is live and static-hosted on surge. Multiplayer (Co-op + Versus)
needs the authoritative WebSocket server in `server/` running on a managed Node
host. This repo is **deploy-ready** — the only remaining input is a host account.

## What's already wired

- **Port** — `server/src/index.ts` listens on `TD_PORT ?? PORT ?? 3001`, so it
  works on Railway/Render (which inject `PORT`) and Fly (fixed internal port 3001).
- **Health check** — `GET /`, `/health`, `/healthz` return `200 {status:"ok"}`.
- **Container** — `Dockerfile.server` (multi-stage, prod-only deps).
- **Host configs** — `railway.json`, `render.yaml`, `fly.toml` all target
  `Dockerfile.server` + `/health`. Pick one.
- **Client** — `client/src/network.ts` reads `VITE_WS_URL` at build time.

## One-time deploy (pick a host)

### Railway (recommended — simplest with Dockerfile)
```bash
railway login           # needs a Railway account/token
railway init            # link this repo to a new project
railway up              # builds Dockerfile.server, deploys, runs health check
railway domain          # prints the public URL, e.g. td-server.up.railway.app
```

### Fly.io
```bash
fly auth login
fly launch --no-deploy  # accept the included fly.toml
fly volumes create td_data --size 1   # persistent SQLite (optional)
fly deploy
```

### Render
Connect the repo in the dashboard (**New → Blueprint**, uses `render.yaml`),
or `render blueprint launch`.

## Point the client at the server + redeploy client

Once the host gives a public URL (use the `wss://` scheme — the surge client is
HTTPS, so an insecure `ws://` will be blocked by the browser):

```bash
# from a fresh clone of github.com/spanol/tower-defense
VITE_WS_URL=wss://<host-url> pnpm --filter @td/client build
SURGE_LOGIN=viniciusspanol+hubbo-deploy@gmail.com SURGE_TOKEN=<token> \
  npx --yes surge ./client/dist tower-defense-spa.surge.sh
```

Multiplayer is then live. The lobby's "server offline — coming soon" message
only shows on connection failure, so a healthy server flips it automatically.

## Notes / caveats

- **SQLite persistence**: the DB lives at `/data/td.sqlite` (`TD_DB_PATH`).
  Railway/Fly volumes and Render disks persist it; on free tiers without a
  volume it's ephemeral (match history/leaderboard reset on redeploy) — fine
  for launch, attach a volume later for durability.
- **Free-tier sleep**: free instances may cold-start after idle; first lobby
  connect can take a few seconds. The client already auto-reconnects.
