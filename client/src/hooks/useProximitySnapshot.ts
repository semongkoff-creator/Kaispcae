import { useSyncExternalStore } from 'react';
import { ProximityPlayer } from '@virtualmeet/shared';
import { getProximitySnapshot, subscribeProximity } from '@/stores/remotePositions';

/**
 * The current proximity result, for components that render from it.
 *
 * Subscribes directly to the snapshot instead of receiving it as a prop from
 * App. Passing it down meant App had to hold it in state, so the proximity
 * tick — which fires whenever anyone nearby moves, several times a second —
 * re-rendered App and its entire tree to deliver a value only three
 * components actually read.
 *
 * useSyncExternalStore rather than a subscribe-and-setState effect: it is the
 * React 18 primitive for exactly this, and it keeps the value consistent
 * within a render pass instead of tearing between components that read it.
 */
export function useProximitySnapshot(): ProximityPlayer[] {
  return useSyncExternalStore(subscribeProximity, getProximitySnapshot, getProximitySnapshot);
}
