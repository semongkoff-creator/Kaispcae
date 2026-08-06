interface MovementBounds {
  mapWidth: number;
  mapHeight: number;
  tileSize: number;
}

interface StopData {
  x?: unknown;
  y?: unknown;
  direction?: unknown;
}

interface StoppedPayload {
  id: string;
  x: number;
  y: number;
  direction: string;
}

function clampPosition(x: number, y: number, bounds: MovementBounds) {
  const min = bounds.tileSize / 2;
  return {
    x: Math.max(min, Math.min(bounds.mapWidth * bounds.tileSize - min, x)),
    y: Math.max(min, Math.min(bounds.mapHeight * bounds.tileSize - min, y)),
  };
}

export function createStoppedPayload(playerId: string, data: StopData, bounds: MovementBounds): StoppedPayload | null {
  if (typeof data?.x !== 'number' || typeof data?.y !== 'number') return null;
  if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;

  const position = clampPosition(data.x, data.y, bounds);
  return {
    id: playerId,
    x: position.x,
    y: position.y,
    direction: typeof data.direction === 'string' ? data.direction : 'down',
  };
}
