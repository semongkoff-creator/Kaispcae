// Long display names were overflowing/overlapping their containers — the
// avatar nametag pill (canvas-drawn, sizes itself to the full text width)
// and the seat-claim request cards (plain text, no width cap) both grow
// unbounded with a long name. Cuts to maxChars and appends an ellipsis
// rather than relying on CSS truncation, since the nametag is drawn on
// canvas (no CSS box to truncate) and this keeps both call sites consistent.
export function truncateName(name: string | null | undefined, maxChars: number): string {
  // Total on purpose. Every caller reads a name off a record that arrives over
  // the network — an avatar, a seat owner, a claim requester — and a partial
  // payload leaves it undefined however carefully the types are written (the
  // socket handlers cast, so the compiler never sees it). One of those threw
  // inside the canvas render loop and took the whole canvas down with it, so
  // this returns something drawable rather than trusting its input.
  if (!name) return '';
  if (name.length <= maxChars) return name;
  return `${name.slice(0, maxChars - 1).trimEnd()}…`;
}
