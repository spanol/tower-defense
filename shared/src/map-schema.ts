import type { GameMap, TileType } from "./types.js";

/**
 * First map: "Forest Path"
 * 15x10 grid, 32px tiles
 * S = start, E = end, P = path, B = buildable, X = blocked
 */
const FOREST_LAYOUT = `
XXXXXBBBXXXXXXX
SPPPPPBBXXXXXXX
XXXXXPBXXXXXXXX
XXXXXPBBBXXXXXX
XXXXXPPPPPXXXXX
XXXXXXXXXPXXXXX
XXXXXXXBBPXXXXX
XXXXXXXBPPPPPEX
XXXXXXXBXXXXXXX
XXXXXXXXXXXXXXX
`.trim();

function charToTile(c: string): TileType {
  switch (c) {
    case "S": return "start";
    case "E": return "end";
    case "P": return "path";
    case "B": return "buildable";
    default: return "blocked";
  }
}

function parseLayout(layout: string): { tiles: TileType[][]; path: { col: number; row: number }[] } {
  const lines = layout.split("\n");
  const tiles: TileType[][] = [];
  const pathTiles: { col: number; row: number; type: TileType }[] = [];

  for (let row = 0; row < lines.length; row++) {
    const tileRow: TileType[] = [];
    for (let col = 0; col < lines[row].length; col++) {
      const type = charToTile(lines[row][col]);
      tileRow.push(type);
      if (type === "start" || type === "path" || type === "end") {
        pathTiles.push({ col, row, type });
      }
    }
    tiles.push(tileRow);
  }

  // Build ordered path by walking from start
  const start = pathTiles.find((t) => t.type === "start");
  if (!start) throw new Error("Map has no start tile");

  const visited = new Set<string>();
  const path: { col: number; row: number }[] = [];
  const queue = [{ col: start.col, row: start.row }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.col},${current.row}`;
    if (visited.has(key)) continue;
    visited.add(key);
    path.push(current);

    const neighbors = [
      { col: current.col + 1, row: current.row },
      { col: current.col - 1, row: current.row },
      { col: current.col, row: current.row + 1 },
      { col: current.col, row: current.row - 1 },
    ];

    for (const n of neighbors) {
      const nKey = `${n.col},${n.row}`;
      if (!visited.has(nKey) && pathTiles.some((t) => t.col === n.col && t.row === n.row)) {
        queue.push(n);
      }
    }
  }

  return { tiles, path };
}

const forestParsed = parseLayout(FOREST_LAYOUT);

export const MAPS: Record<string, GameMap> = {
  forest: {
    name: "Forest Path",
    cols: 15,
    rows: 10,
    tileSize: 32,
    tiles: forestParsed.tiles,
    path: forestParsed.path,
  },
};

export const DEFAULT_MAP = "forest";
