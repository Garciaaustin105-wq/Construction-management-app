// Canvas helper that bakes a tax-evident date/job watermark onto a receipt
// photo and returns a stamped JPEG blob + a small thumbnail data URL.
// Client-only (uses DOM canvas / Image).

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = 0.85
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
 * Stamp a capture date + job name onto the bottom of an image.
 * Returns { blob: stamped JPEG, thumb: small data URL for list rendering }.
 */
export async function stampImage(
  file: File,
  opts: { date: Date; jobName: string }
): Promise<{ blob: Blob; thumb: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);

    // Cap very large images to keep storage/memory reasonable.
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(img, 0, 0, w, h);

    // Watermark bar
    const stamp = `${opts.jobName} · ${opts.date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
    const fontSize = Math.max(14, Math.round(w / 40));
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    const padX = fontSize * 0.6;
    const barH = Math.round(fontSize * 2);
    const barY = h - barH;
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, barY, w, barH);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(stamp, padX, barY + barH / 2);

    const blob = await canvasToBlob(canvas);

    // Thumbnail (max 240px wide) as a data URL for cheap list rendering.
    const thumbW = Math.min(240, w);
    const thumbH = Math.round((thumbW / w) * h);
    const tcanvas = document.createElement("canvas");
    tcanvas.width = thumbW;
    tcanvas.height = thumbH;
    const tctx = tcanvas.getContext("2d");
    if (!tctx) throw new Error("Canvas 2D context unavailable");
    tctx.drawImage(canvas, 0, 0, thumbW, thumbH);
    const thumb = tcanvas.toDataURL("image/jpeg", 0.6);

    return { blob, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}