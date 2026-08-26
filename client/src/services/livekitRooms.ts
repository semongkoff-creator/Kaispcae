// Which rooms use LiveKit instead of the mesh.
//
// Per-room, and not a global switch, because the two cannot interoperate at
// all: a browser publishing to an SFU and a browser offering a peer connection
// have nothing to say to each other. A room is therefore entirely on one or
// entirely on the other, and switching one over cannot affect anybody in a
// different room.
//
// This is the mechanism the migration plan calls Fase 05, brought forward to
// the beginning rather than left to the end. Landing the m-line fix taught
// what a media change with no way to stage it costs: it went out during
// working hours, every old-bundle client and new-bundle client pair died on
// contact, and it had to be reverted within the hour. There is no version of
// mesh-to-SFU that survives being switched on for everyone at once.

// Comma-separated room slugs, at build time. Empty — the shipped default —
// means every room stays on the mesh and none of the LiveKit code path is
// reachable at all.
//
// Build-time and not runtime is deliberate: the alternative is asking the
// server on every room entry, which puts a network round trip in front of
// joining, to answer a question that changes about once a week.
const RAW = (import.meta.env.VITE_LIVEKIT_ROOMS as string | undefined) ?? '';

const ENABLED_ROOMS: ReadonlySet<string> = new Set(
  RAW.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

/**
 * `*` switches every room over at once.
 *
 * Deliberately supported, and deliberately not the default: it is what the
 * last room's migration looks like, and having to spell it out is a reasonable
 * amount of friction for something that cannot be undone without a rebuild.
 */
const ALL = ENABLED_ROOMS.has('*');

export function usesLiveKit(roomSlug: string | null | undefined): boolean {
  if (!roomSlug) return false;
  return ALL || ENABLED_ROOMS.has(roomSlug.toLowerCase());
}

/** For the diagnostics panel — which rooms this build would route to LiveKit. */
export function liveKitRoomList(): string[] {
  return [...ENABLED_ROOMS];
}
