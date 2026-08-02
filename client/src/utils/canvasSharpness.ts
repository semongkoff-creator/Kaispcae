// Pixel-art canvas contexts must disable smoothing so nearest-neighbor
// sampling keeps sprite edges crisp instead of the browser's default
// bilinear blur on scaled drawImage() calls. Must be re-applied every time
// canvas.width/height changes — that resets ALL 2D context state, this flag
// included — not just once on mount. Vendor-prefixed fallbacks cover older
// WebKit/Gecko builds that never adopted the unprefixed property.
interface LegacyCanvasContext extends CanvasRenderingContext2D {
  webkitImageSmoothingEnabled?: boolean;
  mozImageSmoothingEnabled?: boolean;
}

export function disableImageSmoothing(ctx: CanvasRenderingContext2D): void {
  ctx.imageSmoothingEnabled = false;
  const legacy = ctx as LegacyCanvasContext;
  legacy.webkitImageSmoothingEnabled = false;
  legacy.mozImageSmoothingEnabled = false;
}
