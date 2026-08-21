import { getSpriteImage } from './spriteLoader';

// Pre-scaled copies of large images, so the render loop never asks the GPU to
// downscale a huge source every frame.
//
// The case this exists for: a room built from an uploaded floor-plan photo
// rather than tiles (see gameStore's liveReferenceImage). drawLiveReferenceImage
// passed the FULL source — naturalWidth x naturalHeight, which for a photo of a
// floor plan is routinely several thousand pixels square — and asked for it
// scaled down to the map's on-screen size, sixty times a second.
//
// Measured cost of that, in production: the draw phase containing it averaged
// 22ms per frame while the room contained ZERO furniture, and the frame-time
// distribution was bimodal — p50 2.7ms, p95 250ms. That shape is texture cache
// thrashing rather than raw pixel work: an image that large evicts everything
// else (the character spritesheets, most visibly), so some frames find all
// their textures resident and cost nothing while others re-upload and cost a
// quarter of a second. It also explains why the avatar phase spiked in lockstep
// with this one despite drawing only a few sprites per player.
//
// This works alongside the viewport crop in drawLiveReferenceImage, not instead
// of it: the crop stops us SAMPLING pixels that are off screen, while this stops
// the enormous source texture from having to be resident at all. Either alone
// leaves half the cost.

interface Entry {
  bitmap: ImageBitmap | null;
}

const cache = new Map<string, Entry>();

// Below this ratio the pre-scale is not worth a second copy in memory — the
// GPU handles a mild downscale without complaint.
const MIN_SHRINK_RATIO = 1.5;
// Never build something enormous in the name of avoiding something enormous.
const MAX_DIMENSION = 4096;

/**
 * A copy of `src` pre-scaled to roughly `dWidth` x `dHeight`, or null if one
 * isn't available yet (still decoding, still scaling, not worth scaling, or
 * unsupported). Callers draw the original when this returns null, so a room
 * never renders blank waiting for it.
 */
export function getScaledImage(src: string, dWidth: number, dHeight: number): ImageBitmap | null {
  const w = Math.max(1, Math.round(dWidth));
  const h = Math.max(1, Math.round(dHeight));
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) return null;

  const key = `${src}@${w}x${h}`;
  const existing = cache.get(key);
  // Present-and-null means "in flight, or we gave up" — either way, do not
  // start another one. This runs inside the render loop.
  if (existing) return existing.bitmap;

  const img = getSpriteImage(src);
  if (!img) return null; // not decoded yet; ask again next frame

  // A source that isn't much bigger than the destination gains nothing here.
  if (img.naturalWidth < w * MIN_SHRINK_RATIO && img.naturalHeight < h * MIN_SHRINK_RATIO) return null;
  if (typeof createImageBitmap !== 'function') return null;

  const entry: Entry = { bitmap: null };
  cache.set(key, entry);
  createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    .then((bitmap) => { entry.bitmap = bitmap; })
    .catch((err) => {
      // The entry stays, with a null bitmap: retrying every frame against an
      // image that cannot be scaled would be worse than the original problem.
      console.warn('[scaledImage] pre-scale failed, drawing the original instead:', err);
    });
  return null;
}

/** Test seam. */
export function __clearScaledImageCache(): void {
  for (const entry of cache.values()) entry.bitmap?.close();
  cache.clear();
}
