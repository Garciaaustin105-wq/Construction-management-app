// Client-only image normalization: apply EXIF orientation and re-encode as a
// size-capped JPEG before upload.
//
// WHY: phone photos (iPhone HEIC in particular) carry an EXIF orientation tag.
// Supabase's image-transform endpoint (imgproxy) auto-rotates JPEG but does NOT
// honor EXIF for HEIC, so a transformed thumbnail renders rotated while the
// full-res original is rotated correctly by the browser — producing the
// "elongated, then snaps to the right size" flash in the lightbox. Desktop
// Chrome also can't render HEIC at all. Re-orienting + converting to JPEG on the
// client (the phone, which CAN decode its own HEIC) before upload makes the
// stored bytes upright and universally renderable, so thumbnail and full-res
// always agree.
//
// This is DOM-only (canvas / createImageBitmap / Image) — same pattern as
// stampImage.ts. Never import this from a server module.

const DEFAULT_MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = JPEG_QUALITY
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))),
      type,
      quality
    );
  });
}

/**
 * Decode a File into correctly-oriented pixels.
 *
 * Primary path: `createImageBitmap` with `imageOrientation: 'from-image'` —
 * applies the EXIF orientation tag and drops it, so the bitmap is upright.
 * Fallback: an `HTMLImageElement` (modern browsers honor EXIF for `<img>`
 * rendering, and most honor it for `drawImage` too). If both fail (e.g. a format
 * the current browser can't decode, such as HEIC on desktop Chrome), returns
 * null so the caller can fall back to uploading the original file unchanged.
 */
async function decodeUpright(file: File): Promise<{
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
} | null> {
  // Primary path — createImageBitmap with EXIF auto-orientation.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall through to the <img> path below.
    }
  }

  // Fallback path — HTMLImageElement. The browser honors EXIF for <img>
  // rendering; drawImage then copies those (oriented) pixels onto the canvas.
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not load image"));
        el.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * Normalize an image File/Blob for upload: apply EXIF orientation, cap the
 * longest edge at `maxDim`, and re-encode as JPEG.
 *
 * Returns the JPEG Blob. If the bytes can't be decoded in this browser (rare —
 * e.g. HEIC on desktop Chrome), returns the original `file` unchanged so the
 * caller can still upload something rather than fail the whole batch.
 */
export async function normalizeImage(
  file: File | Blob,
  maxDim = DEFAULT_MAX_DIM
): Promise<Blob> {
  const decoded = await decodeUpright(file as File);
  if (!decoded) return file as Blob;

  const { source, width, height } = decoded;
  if (!width || !height) {
    if (typeof (source as ImageBitmap).close === "function") (source as ImageBitmap).close();
    return file as Blob;
  }

  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (typeof (source as ImageBitmap).close === "function") (source as ImageBitmap).close();
    return file as Blob;
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  if (typeof (source as ImageBitmap).close === "function") (source as ImageBitmap).close();

  try {
    return await canvasToBlob(canvas);
  } catch {
    return file as Blob;
  }
}