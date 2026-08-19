import { Direction } from '@virtualmeet/shared';

// The local avatar's position, live, outside React.
//
// The render loop produces a new position every animation frame. Routing
// that through the store meant a new `localPlayer` object 60x/second, and
// every component subscribed to it — App.tsx included, with its whole JSX
// tree — re-rendered at that rate. The canvas never needed the round trip:
// it already draws from the movement result directly. React only needs the
// position at human granularity (proximity, zone entry, panels), which is
// what the throttled store write now provides.
//
// So: the render loop writes HERE every frame (free — a plain object), and
// writes to the store only occasionally. Anything that needs the exact
// current position at an arbitrary moment — a nudge, a sit check, a click
// handler — reads this instead of the store, and gets a value that is
// never stale rather than one that can lag by up to the throttle interval.
export interface LivePosition {
  x: number;
  y: number;
  direction: Direction;
  isMoving: boolean;
}

export const livePos: LivePosition = {
  x: 0,
  y: 0,
  direction: 'down',
  isMoving: false,
};

/** Seeds the live position from an authoritative jump (spawn, teleport,
 *  sit, server correction) so the two never disagree after a hard set. */
export function setLivePosition(x: number, y: number, direction?: Direction): void {
  livePos.x = x;
  livePos.y = y;
  if (direction) livePos.direction = direction;
}
