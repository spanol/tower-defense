/**
 * REST API for player profiles, match history, leaderboard, and analytics.
 * Runs on the same HTTP server that upgrades WebSocket connections.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { playerDb, matchDb, analyticsDb } from "./db.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void;

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];

function route(method: string, path: string, handler: RouteHandler) {
  // Convert /api/players/:id to regex with named groups
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"
  );
  routes.push({ method, pattern, handler });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── Player endpoints ──────────────────────────────────

route("POST", "/api/players", async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const { id, name } = body;
  if (!id || !name) return json(res, { error: "id and name required" }, 400);
  if (typeof name !== "string" || name.length < 1 || name.length > 30) {
    return json(res, { error: "name must be 1-30 characters" }, 400);
  }
  const player = playerDb.upsert(id, name);
  json(res, player, 201);
});

route("GET", "/api/players/:id", (_req, res, params) => {
  const stats = playerDb.getStats(params.id);
  if (!stats) return json(res, { error: "Player not found" }, 404);
  json(res, stats);
});

route("GET", "/api/players/:id/matches", (_req, res, params) => {
  const matches = matchDb.history(params.id, 50);
  json(res, matches);
});

route("GET", "/api/leaderboard", (_req, res) => {
  const leaders = playerDb.leaderboard(20);
  json(res, leaders);
});

// ── Analytics endpoints ───────────────────────────────

route("GET", "/api/analytics/events", (_req, res) => {
  const counts = analyticsDb.eventCounts("-7 days");
  json(res, counts);
});

route("GET", "/api/analytics/metrics", (_req, res) => {
  const metrics = analyticsDb.gameMetrics("-7 days");
  json(res, metrics);
});

// ── Router ────────────────────────────────────────────

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  const url = req.url?.split("?")[0];
  if (!url?.startsWith("/api/")) return false;

  for (const r of routes) {
    if (req.method !== r.method) continue;
    const match = url.match(r.pattern);
    if (match) {
      try {
        await r.handler(req, res, (match.groups ?? {}) as Record<string, string>);
      } catch (err) {
        json(res, { error: "Internal server error" }, 500);
      }
      return true;
    }
  }

  json(res, { error: "Not found" }, 404);
  return true;
}
