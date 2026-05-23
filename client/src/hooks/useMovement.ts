import { useEffect, useRef, useCallback } from 'react';
import { Direction, TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, PLAYER_SPEED } from '@virtualmeet/shared';

interface UseMovementOptions {
  isBlocked: (tileX: number, tileY: number) => boolean;
  onMove: (x: number, y: number, direction: Direction) => void;
}

interface MovementState {
  direction: Direction;
  isMoving: boolean;
  dx: number;
  dy: number;
}

/**
 * Tracks keyboard input (WASD / arrow keys), computes direction and velocity,
 * and provides a collision-checked position update function.
 */
export function useMovement({ isBlocked, onMove }: UseMovementOptions) {
  const keysRef = useRef<Set<string>>(new Set());
  const lastTimeRef = useRef<number>(0);
  const currentXRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);

  // Set player's actual position (called by the renderer loop)
  const setPosition = useCallback((x: number, y: number) => {
    currentXRef.current = x;
    currentYRef.current = y;
  }, []);

  // Read the current input vector (direction + speed)
  const getInput = useCallback((): MovementState => {
    const keys = keysRef.current;
    let dx = 0;
    let dy = 0;
    let direction: Direction = 'down';

    if (keys.has('ArrowUp') || keys.has('KeyW') || keys.has('w')) {
      dy = -1;
      direction = 'up';
    }
    if (keys.has('ArrowDown') || keys.has('KeyS') || keys.has('s')) {
      dy = 1;
      direction = 'down';
    }
    if (keys.has('ArrowLeft') || keys.has('KeyA') || keys.has('a')) {
      dx = -1;
      direction = 'left';
    }
    if (keys.has('ArrowRight') || keys.has('KeyD') || keys.has('d')) {
      dx = 1;
      direction = 'right';
    }

    // Diagonal movement: keep both components for smooth diagonal sliding
    const isMoving = dx !== 0 || dy !== 0;

    return { direction, isMoving, dx, dy };
  }, []);

  /**
   * Attempt to move the player by (dx, dy) pixels, respecting collision.
   * Uses axis-aligned separation: checks X then Y independently so the
   * player can slide along walls.
   */
  const tryMove = useCallback(
    (dt: number) => {
      const { dx, dy, direction, isMoving } = getInput();
      if (!isMoving) return { x: currentXRef.current, y: currentYRef.current, direction, isMoving };

      const stepX = dx * PLAYER_SPEED * dt;
      const stepY = dy * PLAYER_SPEED * dt;

      let newX = currentXRef.current;
      let newY = currentYRef.current;

      // Check X axis independently
      const targetX = currentXRef.current + stepX;
      if (!wouldCollide(targetX, currentYRef.current)) {
        newX = targetX;
      }

      // Check Y axis independently
      const targetY = currentYRef.current + stepY;
      if (!wouldCollide(currentXRef.current, targetY)) {
        newY = targetY;
      }

      return { x: newX, y: newY, direction, isMoving };
    },
    [getInput],
  );

  /**
   * Returns true if a 32x32 box centered on (px, py) would overlap any blocked tile.
   * The player occupies their current tile plus adjacent tiles based on overlap.
   */
  const wouldCollide = useCallback(
    (px: number, py: number) => {
      const half = TILE_SIZE / 2 - 2; // slight padding so players don't clip edges
      const left = px - half;
      const right = px + half;
      const top = py - half;
      const bottom = py + half;

      const minTileX = Math.floor(left / TILE_SIZE);
      const maxTileX = Math.floor((right - 1) / TILE_SIZE);
      const minTileY = Math.floor(top / TILE_SIZE);
      const maxTileY = Math.floor((bottom - 1) / TILE_SIZE);

      for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
          if (isBlocked(tx, ty)) {
            return true;
          }
        }
      }
      return false;
    },
    [isBlocked],
  );

  // Keyboard event listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent browser scrolling with arrow keys
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      keysRef.current.add(e.key);
      if (e.code) keysRef.current.add(e.code);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      if (e.code) keysRef.current.delete(e.code);
    };

    // Reset keys if window loses focus
    const handleBlur = () => {
      keysRef.current.clear();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // The game loop calls this every frame with delta time
  const update = useCallback(
    (dt: number) => {
      const result = tryMove(dt);
      if (result.x !== currentXRef.current || result.y !== currentYRef.current) {
        currentXRef.current = result.x;
        currentYRef.current = result.y;
        onMove(result.x, result.y, result.direction);
      }
      return result;
    },
    [tryMove, onMove],
  );

  return { update, setPosition, getInput };
}
