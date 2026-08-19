// Long display names were overflowing/overlapping their containers — the
// avatar nametag pill (canvas-drawn, sizes itself to the full text width)
// and the seat-claim request cards (plain text, no width cap) both grow
// unbounded with a long name. Cuts to maxChars and appends an ellipsis
// rather than relying on CSS truncation, since the nametag is drawn on
// canvas (no CSS box to truncate) and this keeps both call sites consistent.
export function truncateName(name: string, maxChars: number): string {
  if (name.length <= maxChars) return name;
  return `${name.slice(0, maxChars - 1).trimEnd()}…`;
}
