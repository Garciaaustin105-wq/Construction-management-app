// Shared upload validation — used on the client before any upload (photos,
// receipts, blueprints) and re-checked server-side in the receipts share route.
// Defense in depth: RLS gates who can write; this gates *what* gets written, so
// the app never stores a non-image as a "photo" or a 200MB upload-bomb.

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_BLUEPRINT_SIZE = 25 * 1024 * 1024; // 25 MB (PDFs can be big)

export type UploadKind = "image" | "blueprint";

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
const BLUEPRINT_TYPES = [...IMAGE_TYPES, "application/pdf"];

function isTypeOk(file: File | Blob, allowed: string[]): boolean {
  // `type` can be empty for some camera blobs; accept if it starts with image/.
  const t = file.type;
  if (!t) return false;
  if (allowed.includes(t)) return true;
  // Lenient fallback: any image/* counts (covers odd phone-camera MIMEs like
  // image/heic-sequence that aren't in our explicit list).
  if (t.startsWith("image/")) return true;
  return false;
}

export function validateUpload(
  file: File | Blob,
  kind: UploadKind,
  max = kind === "blueprint" ? MAX_BLUEPRINT_SIZE : MAX_IMAGE_SIZE
): ValidationResult {
  const allowed = kind === "blueprint" ? BLUEPRINT_TYPES : IMAGE_TYPES;
  if (!isTypeOk(file, allowed)) {
    return {
      ok: false,
      error:
        kind === "blueprint"
          ? "Only images or PDF files are allowed."
          : "Only image files are allowed.",
    };
  }
  if (file.size > max) {
    const mb = Math.round(max / (1024 * 1024));
    return {
      ok: false,
      error: `File is too large. Max ${mb} MB.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, error: "File is empty." };
  }
  return { ok: true };
}