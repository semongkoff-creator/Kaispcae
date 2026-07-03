// Cached spritesheet loader for canvas rendering. Images load async but the
// canvas draw loop needs a synchronous "is it ready" check each frame, so we
// cache the <img> element itself and flip a ready flag once it decodes.

interface CacheEntry {
  img: HTMLImageElement;
  ready: boolean;
}

const cache = new Map<string, CacheEntry>();

export function getSpriteImage(src: string): HTMLImageElement | null {
  let entry = cache.get(src);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false };
    cache.set(src, entry);
    img.onload = () => {
      entry!.ready = true;
    };
    img.onerror = () => {
      cache.delete(src);
      console.error(`[spriteLoader] failed to load ${src}`);
    };
    img.src = src;
  }
  return entry.ready ? entry.img : null;
}

export function preloadSprite(src: string): void {
  getSpriteImage(src);
}

interface DrawFrameOptions {
  // Either a grid cell (col/row × cellWidth/cellHeight), or an explicit
  // srcX/srcY pixel offset (used when the crop isn't a uniform grid — e.g.
  // furniture footprints of varying tile spans). srcX/srcY take precedence
  // over col/row when both are given.
  col?: number;
  row?: number;
  srcX?: number;
  srcY?: number;
  cellWidth: number;
  cellHeight: number;
  dx: number;
  dy: number;
  dWidth?: number;
  dHeight?: number;
}

// Draws one region from a spritesheet. Returns false (and draws nothing)
// if the image hasn't finished loading yet, so callers can fall back.
export function drawSpriteFrame(
  ctx: CanvasRenderingContext2D,
  src: string,
  options: DrawFrameOptions,
): boolean {
  const img = getSpriteImage(src);
  if (!img) return false;

  const { cellWidth, cellHeight, dx, dy } = options;
  const sx = options.srcX ?? (options.col ?? 0) * cellWidth;
  const sy = options.srcY ?? (options.row ?? 0) * cellHeight;
  const dWidth = options.dWidth ?? cellWidth;
  const dHeight = options.dHeight ?? cellHeight;

  ctx.drawImage(
    img,
    sx, sy, cellWidth, cellHeight,
    dx, dy, dWidth, dHeight,
  );
  return true;
}
