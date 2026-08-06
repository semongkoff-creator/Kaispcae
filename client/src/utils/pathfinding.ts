// Grid-based A* for double-click-to-move (see GameCanvas.tsx's
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

// Packs (x,y) into one number for a fast Map/Set key — tile coordinates on
// any real map are a few hundred at most, nowhere near overflowing this.
const KEY_SHIFT = 100000;
const CARDINAL_NEIGHBORS: TileNode[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

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
// this only ever runs once per double-click, not per frame — a plain
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

export function getCardinalWaypointTarget(currentX: number, currentY: number, waypoint: WorldPoint, epsilonPx = 4): WorldPoint {
  const dx = waypoint.x - currentX;
  const dy = waypoint.y - currentY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (absX <= epsilonPx && absY <= epsilonPx) return waypoint;

  if (absX >= absY) {
    return absX > epsilonPx
      ? { x: waypoint.x, y: currentY }
      : { x: currentX, y: waypoint.y };
  }

  return absY > epsilonPx
    ? { x: currentX, y: waypoint.y }
    : { x: waypoint.x, y: currentY };
}
