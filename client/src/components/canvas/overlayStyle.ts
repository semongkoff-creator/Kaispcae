// Per-frame positioning of the DOM overlays that ride on top of the canvas
// (zone banners, banner furniture, note/media markers, claimable-seat
// markers — see GameCanvas.tsx's draw loop).
//
// Those elements are positioned imperatively, once per animation frame, so
// they track the canvas camera exactly. Two things made that far more
// expensive than it needed to be:
//
//  1. No viewport check. Every overlay in the ROOM was restyled every frame,
//     not just the ones on screen. Kaitech's real room has 50+ named areas
//     alone (see the zone-banner JSX's own comment), each carrying 4-5
//     style writes — `font-size`/`width`/`height` among them, which dirty
//     layout, not just the compositor.
//  2. No change check. The overlay's transform genuinely changes every frame
//     while the camera moves, but its font-size/width/height only change on
//     a zoom change, and its visibility/opacity only on an actual state
//     flip — yet all of them were rewritten unconditionally.
//
// setOverlayStyle skips the write when the value is byte-identical to what
// was last written for that element, and cullOverlay hides whatever is off
// screen and reports back so the caller can skip the rest of its work for
// that element entirely.
//
// Both are keyed on the ELEMENT, in a WeakMap, so an overlay that unmounts
// (a zone deleted in the editor, a media object removed) takes its cache
// entry with it — no manual eviction, no leak.

const lastWritten = new WeakMap<HTMLElement, Map<string, string>>();

// `property` is a CSS property name (kebab-case, as setProperty expects),
// NOT a camelCase CSSStyleDeclaration key.
export function setOverlayStyle(el: HTMLElement, property: string, value: string): void {
  let cache = lastWritten.get(el);
  if (!cache) {
    cache = new Map();
    lastWritten.set(el, cache);
  }
  if (cache.get(property) === value) return;
  cache.set(property, value);
  el.style.setProperty(property, value);
}

// How far outside the viewport an overlay still counts as visible. Generous
// on purpose: overlay boxes are anchored at a world position but extend
// beyond it by an amount this doesn't try to model exactly (a banner's text
// height, a marker's `translate(-50%,-50%)` recentering, a media
// thumbnail's own size), and being wrong in the "cull something still
// visible" direction would pop an element off the edge of the screen.
const CULL_MARGIN_PX = 160;

// Returns whether the overlay is on screen. `x`/`y`/`w`/`h` are in the same
// already-zoomed screen pixels the caller feeds to `transform: translate()`;
// `w`/`h` may be approximate (see CULL_MARGIN_PX).
//
// Visibility rather than `display: none` — an absolutely-positioned overlay
// contributes nothing to sibling layout either way, and `visibility` avoids
// tearing down and rebuilding the element's boxes (and, for the media
// markers, restarting an <img> decode) every time one crosses the edge of
// the screen while walking.
export function cullOverlay(
  el: HTMLElement,
  x: number,
  y: number,
  w: number,
  h: number,
  viewW: number,
  viewH: number,
): boolean {
  const onScreen =
    x + w > -CULL_MARGIN_PX &&
    x < viewW + CULL_MARGIN_PX &&
    y + h > -CULL_MARGIN_PX &&
    y < viewH + CULL_MARGIN_PX;
  setOverlayStyle(el, 'visibility', onScreen ? 'visible' : 'hidden');
  return onScreen;
}
