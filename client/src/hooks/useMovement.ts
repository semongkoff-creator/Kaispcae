import { useEffect, useRef, useCallback } from 'react';
import { Direction, TILE_SIZE, PLAYER_SPEED, PLAYER_RUN_SPEED, ImpassableAreaRect, doesRectOverlapImpassableArea } from '@kaispace/shared';

// Bug 7 — half-width of the movement hitbox while standing/arriving on a
// door tile, vs. the normal TILE_SIZE/2 - 2 (14px, i.e. a 28px hitbox) used
// everywhere else. 6px gives a 12px hitbox: about 10px of slack per side
// along the wall-parallel axis instead of 2px, so lining up with a 1-tile
// doorway no longer takes near-pixel-perfect alignment, without changing
// collision against any wall tile itself (see wouldCollide below).
const DOOR_MARGIN_PX = 6;

interface UseMovementOptions {
  isBlocked: (tileX: number, tileY: number) => boolean;
  onMove: (x: number, y: number, direction: Direction, isRunning: boolean) => void;
  // While this returns true, WASD/arrow input is ignored entirely (used
  // while sitting) — checked fresh every frame, same ref pattern as
  // isBlocked, so GameCanvas doesn't need to recreate the hook's callbacks.
  isFrozen?: () => boolean;
  // Bug 7 — reports whether a tile is a door, so wouldCollide can shrink the
  // hitbox specifically there (see its own comment). Optional so a caller
  // that never wires it up (there are none today, but future consumers of
  // this hook shouldn't be forced to) just keeps the old door-is-a-normal-
  // tile behaviour.
  isDoor?: (tileX: number, tileY: number) => boolean;
  // Item #9 (precise-collision follow-up) — Impassable Area rectangles
  // (pixel space), checked as a full hitbox-vs-rect overlap alongside the
  // tile-grid check in wouldCollide — same "read fresh every call via a
  // getter, never triggers a hook recreation" pattern as isBlocked/isDoor.
  // Optional so a caller that never wires it up just gets zero areas (no
  // behavior change for anything that predates this).
  getImpassableAreas?: () => ImpassableAreaRect[];
}

export interface MovementState {
  direction: Direction;
  isMoving: boolean;
  dx: number;
  dy: number;
  isRunning: boolean;
}

function movementForKey(key: string): Pick<MovementState, 'direction' | 'dx' | 'dy'> | null {
  if (key === 'ArrowUp' || key === 'KeyW') return { direction: 'up', dx: 0, dy: -1 };
  if (key === 'ArrowDown' || key === 'KeyS') return { direction: 'down', dx: 0, dy: 1 };
  if (key === 'ArrowLeft' || key === 'KeyA') return { direction: 'left', dx: -1, dy: 0 };
  if (key === 'ArrowRight' || key === 'KeyD') return { direction: 'right', dx: 1, dy: 0 };
  return null;
}

export function getKeyboardMovementInput(keys: ReadonlySet<string>, fallbackDirection: Direction = 'down'): MovementState {
  let movement: Pick<MovementState, 'direction' | 'dx' | 'dy'> | null = null;
  for (const key of keys) {
    movement = movementForKey(key) ?? movement;
  }

  const isMoving = movement !== null;
  const isRunning = isMoving && (
    keys.has('KeyR') ||
    keys.has('ShiftLeft') || keys.has('ShiftRight')
  );

  return {
    direction: movement?.direction ?? fallbackDirection,
    isMoving,
    dx: movement?.dx ?? 0,
    dy: movement?.dy ?? 0,
    isRunning,
  };
}

export function useMovement({ isBlocked, onMove, isFrozen, isDoor, getImpassableAreas }: UseMovementOptions) {
  const keysRef = useRef<Set<string>>(new Set());
  const currentXRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const lastDirectionRef = useRef<Direction>('down');

  // Refs to keep callbacks stable across renders — prevents the dependency
  // chain from cascading up to the rAF loop in GameCanvas.
  const isBlockedRef = useRef(isBlocked);
  isBlockedRef.current = isBlocked;

  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const isFrozenRef = useRef(isFrozen);
  isFrozenRef.current = isFrozen;

  const isDoorRef = useRef(isDoor);
  isDoorRef.current = isDoor;

  const getImpassableAreasRef = useRef(getImpassableAreas);
  getImpassableAreasRef.current = getImpassableAreas;

  const setPosition = useCallback((x: number, y: number) => {
    currentXRef.current = x;
    currentYRef.current = y;
  }, []);

  const getInput = useCallback((): MovementState => {
    const keys = keysRef.current;
    // Run/sprint only means anything while actually moving — holding it alone
    // with no direction key does nothing, same as every other game. A4 adds
    // Shift as an alias for R (same PLAYER_RUN_SPEED — one sprint system, not
    // two). This ONLY feeds the speed pick in tryMove; it does not touch the
    // ref/state architecture, so the movement-responsiveness fix is untouched.
    return getKeyboardMovementInput(keys, lastDirectionRef.current);
  }, []);

  // Collision check reads isBlocked from ref — never changes identity
  const wouldCollide = useCallback(
    (px: number, py: number) => {
      // Bug 7 — a doorway is exactly one tile wide, so the normal hitbox
      // (28px out of a 32px tile — only ~2px slack per side) demanded the
      // player be within a few pixels of dead-center on the axis running
      // along the wall, or its edge clipped the wall tile right next to the
      // door. Standing/arriving on a door tile shrinks the hitbox instead
      // (12px — DOOR_MARGIN_PX slack per side), so squeezing through no
      // longer needs to be pixel-perfect. Only checked at THIS point, so it
      // never loosens collision against a wall tile itself — a door tile is
      // never in BLOCKED_TILES to begin with, this only affects how forgiving
      // the approach INTO/OUT OF it is.
      const doorTileX = Math.floor(px / TILE_SIZE);
      const doorTileY = Math.floor(py / TILE_SIZE);
      const half = isDoorRef.current?.(doorTileX, doorTileY) ? DOOR_MARGIN_PX : TILE_SIZE / 2 - 2;
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

      // Item #9 (precise-collision follow-up) — sub-tile check, separate
      // from the tile-grid loop above (Impassable Area rectangles are never
      // rasterized into tiles — see mapLayers.ts's getImpassableAreaRects
      // doc comment). Full hitbox-vs-rect overlap, same box as the tile
      // check just used (left/right/top/bottom already computed above).
      const areas = getImpassableAreasRef.current?.();
      if (areas && areas.length > 0 && doesRectOverlapImpassableArea(areas, left, top, right, bottom)) {
        return true;
      }

      return false;
    },
    [], // stable — reads from ref
  );

  const tryMove = useCallback(
    (dt: number) => {
      const { dx, dy, direction, isMoving, isRunning } = getInput();
      const isFrozen = isFrozenRef.current?.() === true;
      if (!isMoving || isFrozen) {
        return {
          x: currentXRef.current,
          y: currentYRef.current,
          direction: lastDirectionRef.current,
          isMoving: false,
          isRunning: false,
        };
      }
      lastDirectionRef.current = direction;

      const speed = isRunning ? PLAYER_RUN_SPEED : PLAYER_SPEED;
      const stepX = dx * speed * dt;
      const stepY = dy * speed * dt;

      let newX = currentXRef.current;
      let newY = currentYRef.current;

      // Bug 8 safety net — if the avatar is ALREADY embedded in collision
      // geometry (e.g. restored onto a chair tile after a mid-sit reconnect,
      // or any other inconsistent state this code can't foresee), normal
      // collision would reject every move and the player would be stuck
      // permanently. Already-colliding means it can't get worse: let any
      // movement through so the player can simply walk out; the moment
      // they're clear, this is false again and normal collision resumes.
      const embedded = wouldCollide(currentXRef.current, currentYRef.current);

      const targetX = currentXRef.current + stepX;
      if (embedded || !wouldCollide(targetX, currentYRef.current)) {
        newX = targetX;
      }

      const targetY = currentYRef.current + stepY;
      if (embedded || !wouldCollide(currentXRef.current, targetY)) {
        newY = targetY;
      }

      return { x: newX, y: newY, direction, isMoving, isRunning };
    },
    [getInput, wouldCollide], // both stable — never recreates
  );

  // Same collision-checked stepping as tryMove, but driven toward an
  // arbitrary pixel target instead of keyboard input — used by the Follow
  // feature (see GameCanvas.tsx) to auto-trail another player. Deliberately
  // NOT wired into keysRef/getInput at all, so it can never be confused
  // with "the user pressed a movement key" (GameCanvas relies on that
  // distinction to auto-unfollow the instant a *real* key press happens —
  // see §3's rule: any manual move immediately cancels an active follow).
  const tryMoveToward = useCallback(
    (targetX: number, targetY: number, dt: number) => {
      const curX = currentXRef.current;
      const curY = currentYRef.current;
      const distX = targetX - curX;
      const distY = targetY - curY;
      const dist = Math.hypot(distX, distY);

      // Close enough — stop, rather than jittering around the target
      // forever as it keeps moving by sub-pixel amounts each frame.
      if (dist < 4) {
        return { x: curX, y: curY, direction: lastDirectionRef.current, isMoving: false, isRunning: false };
      }

      const stepDist = Math.min(dist, PLAYER_SPEED * dt);
      const stepX = (distX / dist) * stepDist;
      const stepY = (distY / dist) * stepDist;
      const direction: Direction = Math.abs(distX) > Math.abs(distY)
        ? (distX > 0 ? 'right' : 'left')
        : (distY > 0 ? 'down' : 'up');
      lastDirectionRef.current = direction;

      let newX = curX;
      let newY = curY;

      // Same embedded-escape rule as tryMove (Bug 8 safety net) — a stuck
      // follower should un-stick by following, same as by walking.
      const embedded = wouldCollide(curX, curY);

      const nextX = curX + stepX;
      if (embedded || !wouldCollide(nextX, curY)) newX = nextX;

      const nextY = curY + stepY;
      if (embedded || !wouldCollide(curX, nextY)) newY = nextY;

      return { x: newX, y: newY, direction, isMoving: newX !== curX || newY !== curY, isRunning: false };
    },
    [wouldCollide], // stable — never recreates
  );

  // Public wrapper mirroring update()'s ref-syncing/onMove-firing contract
  // — GameCanvas calls this instead of update() for frames where an active
  // follow target should drive movement instead of the keyboard.
  const updateFollow = useCallback(
    (targetX: number, targetY: number, dt: number) => {
      const result = tryMoveToward(targetX, targetY, dt);
      const moved = result.x !== currentXRef.current || result.y !== currentYRef.current;
      if (moved) {
        currentXRef.current = result.x;
        currentYRef.current = result.y;
        onMoveRef.current(result.x, result.y, result.direction, result.isRunning);
      }
      return result;
    },
    [tryMoveToward], // stable — never recreates
  );

  const update = useCallback(
    (dt: number) => {
      const result = tryMove(dt);
      const moved = result.x !== currentXRef.current || result.y !== currentYRef.current;
      if (moved) {
        currentXRef.current = result.x;
        currentYRef.current = result.y;
      }
      // Fire on direction-only changes too (moved === false but a movement
      // key is still held) — otherwise walking up to something blocking
      // (a wall, a chair) and pressing further into it never updates
      // localPlayer.direction in the store, since collision keeps x/y
      // unchanged. That left facing-direction-dependent interactions (the
      // chair sit prompt, in particular) permanently stuck on whatever
      // direction the player last successfully moved in, rather than the
      // direction they're actually pressing/facing now.
      if (moved || result.isMoving) {
        onMoveRef.current(result.x, result.y, result.direction, result.isRunning);
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

    // Bug — this used to early-return on the same "don't touch movement
    // while typing" check handleKeyDown uses. That's the right guard for
    // keyDOWN (don't hijack typing as a movement key), but wrong for keyUP:
    // if focus shifted to an input WHILE a movement key was still physically
    // held (e.g. clicking the chat box mid-sprint), the eventual release
    // got silently ignored — the key stayed stuck in keysRef forever, and
    // the avatar kept walking on its own in that direction even after the
    // player let go. A key release must always clear the tracked key
    // regardless of where focus currently is; only a NEW keydown should be
    // gated by "are we typing right now".
    const handleKeyUp = (e: KeyboardEvent) => {
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

  return { update, setPosition, getInput, updateFollow };
}
