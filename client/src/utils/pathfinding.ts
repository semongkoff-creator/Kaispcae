// Grid-based A* for click-to-move (see GameCanvas.tsx's
// walkTargetRef). That feature used to just walk in a straight line toward
// the clicked tile with the normal per-axis collision slide — fine on open
// floor, but a desk sitting between the player and the target just stopped
// the walk dead instead of routing around it. This runs 4-directional A*
// over the tile grid once, up front (not per frame), and hands back a
// waypoint list to walk through instead of a single target point. Keeping
// the route cardinal makes click-to-move feel like WASD instead of drifting
// diagonally across tile centers.

export interface TileNode {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export type CardinalDirection = 'up' | 'down' | 'left' | 'right';

export interface RouteState {
  targetTile: TileNode | null;
  waypoints: WorldPoint[] | null;
  failedStartTile?: TileNode | null;
  failedAtMs?: number | null;
}

export interface FollowRouteTargetInput {
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  targetDirection: CardinalDirection;
  blocked: (tx: number, ty: number) => boolean;
  cols: number;
  rows: number;
  tileSize: number;
  route: RouteState;
  epsilonPx?: number;
  nowMs?: number;
  failedRetryMs?: number;
}

export interface FollowRouteTargetResult {
  axisTarget: WorldPoint | null;
  route: RouteState;
}

// Packs (x,y) into one number for a fast Map/Set key — tile coordinates on
// any real map are a few hundred at most, nowhere near overflowing this.
const KEY_SHIFT = 100000;
const CARDINAL_NEIGHBORS: TileNode[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];
const FOLLOW_TRAILING_OFFSETS: Record<CardinalDirection, TileNode> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

function key(x: number, y: number): number {
  return x * KEY_SHIFT + y;
}
function decode(k: number): TileNode {
  const x = Math.floor(k / KEY_SHIFT);
  return { x, y: k - x * KEY_SHIFT };
}

function manhattanHeuristic(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

// `blocked(tx, ty)` must reflect the SAME walkability real movement
// collision uses (tile-grid BLOCKED_TILES + door-password state + furniture
// Impassable Area rects — see GameCanvas.tsx's isBlocked callers) so a
// computed path can never lead the avatar somewhere normal movement would
// then reject on arrival.
//
// Grid is small (a typical office map is a few thousand tiles at most) and
// this only ever runs once per click, not per frame — a plain
// linear scan for the lowest f-score each iteration is simpler than a
// binary heap and still comfortably fast enough at this scale.
export function findTilePath(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  blocked: (tx: number, ty: number) => boolean,
  cols: number,
  rows: number,
): TileNode[] | null {
  if (targetX < 0 || targetY < 0 || targetX >= cols || targetY >= rows) return null;
  if (blocked(targetX, targetY)) return null;

  const startKey = key(startX, startY);
  const targetKey = key(targetX, targetY);
  if (startKey === targetKey) return [];

  const gScore = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();
  const open = new Map<number, TileNode>([[startKey, { x: startX, y: startY }]]);
  const fScore = new Map<number, number>([[startKey, manhattanHeuristic(startX, startY, targetX, targetY)]]);
  const closed = new Set<number>();

  const maxIter = cols * rows + 10;
  let iter = 0;
  let reached = false;

  while (open.size > 0 && iter++ < maxIter) {
    let currentKey = -1;
    let currentNode: TileNode | null = null;
    let bestF = Infinity;
    for (const [k, node] of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < bestF) { bestF = f; currentKey = k; currentNode = node; }
    }
    if (!currentNode) break;
    if (currentKey === targetKey) { reached = true; break; }

    open.delete(currentKey);
    closed.add(currentKey);

    for (const delta of CARDINAL_NEIGHBORS) {
      const nx = currentNode.x + delta.x;
      const ny = currentNode.y + delta.y;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (blocked(nx, ny)) continue;

      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;
      const tentativeG = (gScore.get(currentKey) ?? Infinity) + 1;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + manhattanHeuristic(nx, ny, targetX, targetY));
        if (!open.has(nKey)) open.set(nKey, { x: nx, y: ny });
      }
    }
  }

  if (!reached) return null; // unreachable — e.g. target is in a walled-off area

  const path: TileNode[] = [];
  let cursor = targetKey;
  while (cursor !== startKey) {
    path.push(decode(cursor));
    const prevKey = cameFrom.get(cursor);
    if (prevKey === undefined) return null; // shouldn't happen once reached is true
    cursor = prevKey;
  }
  path.reverse();
  return path;
}

// Collapses straight cardinal runs down to their endpoints — a raw grid path
// has one node per tile, which would otherwise mean a brief stop-and-retarget
// every single tile once GameCanvas walks waypoint-by-waypoint (see its
// walkTargetRef loop).
export function simplifyPath(path: TileNode[]): TileNode[] {
  if (path.length <= 2) return path;
  const out: TileNode[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = path[i];
    const next = path[i + 1];
    const dx1 = Math.sign(cur.x - prev.x);
    const dy1 = Math.sign(cur.y - prev.y);
    const dx2 = Math.sign(next.x - cur.x);
    const dy2 = Math.sign(next.y - cur.y);
    if (dx1 !== dx2 || dy1 !== dy2) out.push(cur);
  }
  out.push(path[path.length - 1]);
  return out;
}

export function tilePathToWorldWaypoints(path: TileNode[], tileSize: number): WorldPoint[] {
  return simplifyPath(path).map((n) => ({
    x: n.x * tileSize + tileSize / 2,
    y: n.y * tileSize + tileSize / 2,
  }));
}

export function isNearWorldPoint(currentX: number, currentY: number, point: WorldPoint, epsilonPx = 4): boolean {
  return Math.abs(point.x - currentX) <= epsilonPx && Math.abs(point.y - currentY) <= epsilonPx;
}

export function getCardinalWaypointTarget(currentX: number, currentY: number, waypoint: WorldPoint, epsilonPx = 4): WorldPoint {
  const dx = waypoint.x - currentX;
  const dy = waypoint.y - currentY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (isNearWorldPoint(currentX, currentY, waypoint, epsilonPx)) return { x: currentX, y: currentY };

  if (absX >= absY) {
    return absX > epsilonPx
      ? { x: waypoint.x, y: currentY }
      : { x: currentX, y: waypoint.y };
  }

  return absY > epsilonPx
    ? { x: currentX, y: waypoint.y }
    : { x: waypoint.x, y: currentY };
}

export function getTrailingTile(targetTileX: number, targetTileY: number, direction: CardinalDirection): TileNode {
  const offset = FOLLOW_TRAILING_OFFSETS[direction] ?? FOLLOW_TRAILING_OFFSETS.down;
  return { x: targetTileX + offset.x, y: targetTileY + offset.y };
}

export function findFollowRouteTarget(input: FollowRouteTargetInput): FollowRouteTargetResult {
  const targetTile = getTrailingTile(
    Math.floor(input.targetX / input.tileSize),
    Math.floor(input.targetY / input.tileSize),
    input.targetDirection,
  );
  const targetChanged =
    input.route.targetTile?.x !== targetTile.x ||
    input.route.targetTile?.y !== targetTile.y;

  const startTileX = Math.floor(input.currentX / input.tileSize);
  const startTileY = Math.floor(input.currentY / input.tileSize);
  const failedStartMatches =
    input.route.failedStartTile?.x === startTileX &&
    input.route.failedStartTile?.y === startTileY;
  const failedAtMs = input.route.failedAtMs;
  const nowMs = input.nowMs;
  const failedRetryMs = input.failedRetryMs ?? 500;
  if (
    !targetChanged &&
    !input.route.waypoints &&
    failedStartMatches &&
    nowMs !== undefined &&
    failedAtMs !== undefined &&
    failedAtMs !== null &&
    nowMs - failedAtMs < failedRetryMs
  ) {
    return { axisTarget: null, route: input.route };
  }

  let waypoints = targetChanged ? null : input.route.waypoints;
  if (!waypoints) {
    if (
      targetTile.x < 0 ||
      targetTile.y < 0 ||
      targetTile.x >= input.cols ||
      targetTile.y >= input.rows ||
      input.blocked(targetTile.x, targetTile.y)
    ) {
      return {
        axisTarget: null,
        route: {
          targetTile,
          waypoints: null,
          failedStartTile: { x: startTileX, y: startTileY },
          failedAtMs: nowMs ?? null,
        },
      };
    }

    if (startTileX === targetTile.x && startTileY === targetTile.y) {
      waypoints = [{
        x: targetTile.x * input.tileSize + input.tileSize / 2,
        y: targetTile.y * input.tileSize + input.tileSize / 2,
      }];
    } else {
      const tilePath = findTilePath(startTileX, startTileY, targetTile.x, targetTile.y, input.blocked, input.cols, input.rows);
      waypoints = tilePath ? tilePathToWorldWaypoints(tilePath, input.tileSize) : null;
    }
  }

  if (!waypoints || waypoints.length === 0) {
    return {
      axisTarget: null,
      route: {
        targetTile,
        waypoints: null,
        failedStartTile: { x: startTileX, y: startTileY },
        failedAtMs: nowMs ?? null,
      },
    };
  }

  return {
    axisTarget: getCardinalWaypointTarget(input.currentX, input.currentY, waypoints[0], input.epsilonPx),
    route: { targetTile, waypoints, failedStartTile: null, failedAtMs: null },
  };
}
