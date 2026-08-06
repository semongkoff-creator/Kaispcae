export interface MovementSnapshot {
  x: number;
  y: number;
  receivedAt: number;
}

export interface MovementSample {
  x: number;
  y: number;
  done: boolean;
}

const MAX_SNAPSHOTS_PER_PLAYER = 8;

export function appendMovementSnapshot(snapshots: MovementSnapshot[], next: MovementSnapshot): MovementSnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (last && next.receivedAt <= last.receivedAt) return snapshots;

  return [...snapshots, next].slice(-MAX_SNAPSHOTS_PER_PLAYER);
}

export function sampleMovementSnapshots(snapshots: MovementSnapshot[], renderTime: number): MovementSample | null {
  if (!snapshots.length) return null;
  if (snapshots.length === 1) {
    const only = snapshots[0];
    return { x: only.x, y: only.y, done: renderTime >= only.receivedAt };
  }

  let before = snapshots[0];
  let after = snapshots[snapshots.length - 1];

  for (let i = 0; i < snapshots.length - 1; i++) {
    const current = snapshots[i];
    const next = snapshots[i + 1];
    if (renderTime >= current.receivedAt && renderTime <= next.receivedAt) {
      before = current;
      after = next;
      break;
    }
  }

  if (renderTime <= snapshots[0].receivedAt) {
    return { x: snapshots[0].x, y: snapshots[0].y, done: false };
  }

  const last = snapshots[snapshots.length - 1];
  if (renderTime >= last.receivedAt) {
    return { x: last.x, y: last.y, done: true };
  }

  const span = after.receivedAt - before.receivedAt;
  const t = span <= 0 ? 1 : (renderTime - before.receivedAt) / span;
  return {
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t,
    done: false,
  };
}
