import { useEffect, useRef, useCallback } from 'react';
import { Direction, TILE_SIZE, PLAYER_SPEED } from '@virtualmeet/shared';

interface UseMovementOptions {
  isBlocked: (tileX: number, tileY: number) => boolean;
  onMove: (x: number, y: number, direction: Direction) => void;
  // While this returns true, WASD/arrow input is ignored entirely (used
  // while sitting) — checked fresh every frame, same ref pattern as
  // isBlocked, so GameCanvas doesn't need to recreate the hook's callbacks.
  isFrozen?: () => boolean;
}

interface MovementState {
  direction: Direction;
  isMoving: boolean;
  dx: number;
  dy: number;
}

export function useMovement({ isBlocked, onMove, isFrozen }: UseMovementOptions) {
  const keysRef = useRef<Set<string>>(new Set());
  const currentXRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);

  // Refs to keep callbacks stable across renders — prevents the dependency
  // chain from cascading up to the rAF loop in GameCanvas.
  const isBlockedRef = useRef(isBlocked);
  isBlockedRef.current = isBlocked;

  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const isFrozenRef = useRef(isFrozen);
  isFrozenRef.current = isFrozen;

  const setPosition = useCallback((x: number, y: number) => {
    currentXRef.current = x;
    currentYRef.current = y;
  }, []);

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

    const isMoving = dx !== 0 || dy !== 0;
    return { direction, isMoving, dx, dy };
  }, []);

  // Collision check reads isBlocked from ref — never changes identity
  const wouldCollide = useCallback(
    (px: number, py: number) => {
      const half = TILE_SIZE / 2 - 2;
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
          if (isBlockedRef.current(tx, ty)) {
            return true;
          }
        }
      }
      return false;
    },
    [], // stable — reads from ref
  );

  const tryMove = useCallback(
    (dt: number) => {
      const { dx, dy, direction, isMoving } = getInput();
      if (!isMoving || isFrozenRef.current?.()) {
        return { x: currentXRef.current, y: currentYRef.current, direction, isMoving: false };
      }

      const stepX = dx * PLAYER_SPEED * dt;
      const stepY = dy * PLAYER_SPEED * dt;

      let newX = currentXRef.current;
      let newY = currentYRef.current;

      const targetX = currentXRef.current + stepX;
      if (!wouldCollide(targetX, currentYRef.current)) {
        newX = targetX;
      }

      const targetY = currentYRef.current + stepY;
      if (!wouldCollide(currentXRef.current, targetY)) {
        newY = targetY;
      }

      return { x: newX, y: newY, direction, isMoving };
    },
    [getInput, wouldCollide], // both stable — never recreates
  );

  const update = useCallback(
    (dt: number) => {
      const result = tryMove(dt);
      if (result.x !== currentXRef.current || result.y !== currentYRef.current) {
        currentXRef.current = result.x;
        currentYRef.current = result.y;
        onMoveRef.current(result.x, result.y, result.direction);
      }
      return result;
    },
    [tryMove], // tryMove is stable — update never recreates
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't process movement keys while user is typing in an input field
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      keysRef.current.add(e.key);
      if (e.code) keysRef.current.add(e.code);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;

      keysRef.current.delete(e.key);
      if (e.code) keysRef.current.delete(e.code);
    };

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

  return { update, setPosition, getInput };
}
