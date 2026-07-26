// Turn a user-picked image File into a small square WebP data-URL entirely in
// the browser, so the heavy original never touches the network or the database.
// Center-crops to a square, downscales to <=256px, encodes WebP at ~q0.8 (falls
// back to JPEG where the browser can't encode WebP). A processed photo is
// typically ~10-40KB — well under the server's ~150KB backstop.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB, rejected before any processing
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const TARGET_SIZE = 256;

// A user-facing, already-translated error — the caller can show err.message
// directly instead of guessing which failure happened.
export class PhotoError extends Error {}

export async function processProfilePhoto(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new PhotoError('Format tidak didukung — pakai JPG, PNG, atau WebP.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PhotoError('File terlalu besar — maksimal 5MB.');
  }

  const bitmap = await loadBitmap(file);
  try {
    // Center-crop to a square taken from the shorter side.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const size = Math.min(TARGET_SIZE, side); // never upscale past the source

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError('Gagal memproses gambar (canvas tidak tersedia).');
    ctx.drawImage(bitmap as CanvasImageSource, sx, sy, side, side, 0, 0, size, size);

    // Prefer WebP; a browser that can't encode it hands back a PNG data-URL
    // (detectable by prefix), in which case fall back to JPEG for size.
    let dataUrl = canvas.toDataURL('image/webp', 0.8);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    }
    return dataUrl;
  } finally {
    // ImageBitmap has close(); the HTMLImageElement fallback doesn't.
    (bitmap as ImageBitmap).close?.();
  }
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new PhotoError('Gagal membaca gambar.'));
    img.src = URL.createObjectURL(file);
  });
}
