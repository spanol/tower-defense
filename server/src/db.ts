/**
 * SQLite database for player profiles, match history, and analytics.
 */

import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.TD_DB_PATH ?? path.join(process.cwd(), "td.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id          TEXT PRIMARY KEY,
    mode        TEXT NOT NULL CHECK (mode IN ('solo','coop','versus')),
    map_key     TEXT NOT NULL,
    waves       INTEGER NOT NULL DEFAULT 0,
    score       INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL CHECK (result IN ('victory','defeat','disconnect')),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS match_players (
    match_id  TEXT NOT NULL REFERENCES matches(id),
    player_id TEXT NOT NULL REFERENCES players(id),
    role      TEXT NOT NULL DEFAULT 'player',
    PRIMARY KEY (match_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    player_id  TEXT,
    match_id   TEXT,
    data       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_matches_started ON matches(started_at);
  CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players(player_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_analytics_time ON analytics_events(created_at);
`);

// ── Player queries ────────────────────────────────────

const insertPlayer = db.prepare(
  `INSERT INTO players (id, name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET id = id RETURNING *`
);

const getPlayerById = db.prepare(`SELECT * FROM players WHERE id = ?`);

const getPlayerByName = db.prepare(`SELECT * FROM players WHERE name = ?`);

const getPlayerStats = db.prepare(`
  SELECT
    p.id,
    p.name,
    p.created_at,
    COUNT(mp.match_id) AS games_played,
    SUM(CASE WHEN m.result = 'victory' THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN m.result = 'defeat' THEN 1 ELSE 0 END) AS losses,
    MAX(m.score) AS best_score,
    MAX(m.waves) AS best_wave
  FROM players p
  LEFT JOIN match_players mp ON mp.player_id = p.id
  LEFT JOIN matches m ON m.id = mp.match_id
  WHERE p.id = ?
  GROUP BY p.id
`);

const getLeaderboard = db.prepare(`
  SELECT
    p.id,
    p.name,
    COUNT(mp.match_id) AS games_played,
    SUM(CASE WHEN m.result = 'victory' THEN 1 ELSE 0 END) AS wins,
    MAX(m.score) AS best_score
  FROM players p
  JOIN match_players mp ON mp.player_id = p.id
  JOIN matches m ON m.id = mp.match_id
  GROUP BY p.id
  ORDER BY best_score DESC
  LIMIT ?
`);

// ── Match queries ─────────────────────────────────────

const insertMatch = db.prepare(`
  INSERT INTO matches (id, mode, map_key, waves, score, result, duration_ms, started_at, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), datetime(?, 'unixepoch'))
`);

const insertMatchPlayer = db.prepare(
  `INSERT OR IGNORE INTO match_players (match_id, player_id, role) VALUES (?, ?, ?)`
);

const getMatchHistory = db.prepare(`
  SELECT m.*, GROUP_CONCAT(p.name) AS player_names
  FROM matches m
  JOIN match_players mp ON mp.match_id = m.id
  JOIN players p ON p.id = mp.player_id
  WHERE m.id IN (
    SELECT match_id FROM match_players WHERE player_id = ?
  )
  GROUP BY m.id
  ORDER BY m.started_at DESC
  LIMIT ?
`);

// ── Analytics queries ─────────────────────────────────

const insertEvent = db.prepare(
  `INSERT INTO analytics_events (event_type, player_id, match_id, data) VALUES (?, ?, ?, ?)`
);

const getEventCounts = db.prepare(`
  SELECT event_type, COUNT(*) AS count
  FROM analytics_events
  WHERE created_at >= datetime('now', ?)
  GROUP BY event_type
  ORDER BY count DESC
`);

const getGameMetrics = db.prepare(`
  SELECT
    COUNT(*) AS total_matches,
    AVG(duration_ms) AS avg_duration_ms,
    AVG(waves) AS avg_waves,
    AVG(score) AS avg_score,
    SUM(CASE WHEN result = 'victory' THEN 1 ELSE 0 END) AS total_victories
  FROM matches
  WHERE started_at >= datetime('now', ?)
`);

// ── Public API ────────────────────────────────────────

export interface PlayerRow {
  id: string;
  name: string;
  created_at: string;
}

export interface PlayerStatsRow {
  id: string;
  name: string;
  created_at: string;
  games_played: number;
  wins: number;
  losses: number;
  best_score: number;
  best_wave: number;
}

export interface MatchRow {
  id: string;
  mode: string;
  map_key: string;
  waves: number;
  score: number;
  result: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  player_names?: string;
}

export const playerDb = {
  upsert(id: string, name: string): PlayerRow {
    return insertPlayer.get(id, name) as PlayerRow;
  },
  getById(id: string): PlayerRow | undefined {
    return getPlayerById.get(id) as PlayerRow | undefined;
  },
  getByName(name: string): PlayerRow | undefined {
    return getPlayerByName.get(name) as PlayerRow | undefined;
  },
  getStats(id: string): PlayerStatsRow | undefined {
    return getPlayerStats.get(id) as PlayerStatsRow | undefined;
  },
  leaderboard(limit = 20): PlayerStatsRow[] {
    return getLeaderboard.all(limit) as PlayerStatsRow[];
  },
};

export const matchDb = {
  record(
    id: string,
    mode: string,
    mapKey: string,
    waves: number,
    score: number,
    result: "victory" | "defeat" | "disconnect",
    durationMs: number,
    startedAt: number,
    finishedAt: number,
    playerIds: string[],
  ): void {
    const startSec = Math.floor(startedAt / 1000);
    const endSec = Math.floor(finishedAt / 1000);
    insertMatch.run(id, mode, mapKey, waves, score, result, durationMs, startSec, endSec);
    for (const pid of playerIds) {
      insertMatchPlayer.run(id, pid, "player");
    }
  },
  history(playerId: string, limit = 20): MatchRow[] {
    return getMatchHistory.all(playerId, limit) as MatchRow[];
  },
};

export const analyticsDb = {
  track(eventType: string, playerId?: string, matchId?: string, data?: Record<string, unknown>): void {
    insertEvent.run(eventType, playerId ?? null, matchId ?? null, data ? JSON.stringify(data) : null);
  },
  eventCounts(since = "-7 days"): Array<{ event_type: string; count: number }> {
    return getEventCounts.all(since) as Array<{ event_type: string; count: number }>;
  },
  gameMetrics(since = "-7 days") {
    return getGameMetrics.get(since);
  },
};

// db instance is used internally; consumers use playerDb, matchDb, analyticsDb
