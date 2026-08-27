import type { SupabaseClient } from "@supabase/supabase-js";

// Image-loading helpers for private Supabase storage buckets.
//
// The thumbnail variant uses Supabase's image-transformation render endpoint:
// the transform (width/quality) is baked into the signed JWT at signing time,
// so the browser downloads a small rendered image instead of the full-res
// original. A list of N items still issues N signed-URL requests (the batched
// `createSignedUrls` call does NOT support `transform`), but each response is a
// tiny transformed image — the payload, not the request count, is what made
// the old grids slow. Full-res is minted on demand (e.g. when a lightbox
// opens), never up front for every item.
//
// If image transformations aren't enabled on the Supabase project, the
// transform option is ignored and the original is served — the on-demand
// full-res change still wins, just without the thumbnail-size savings.

export async function signedThumbnail(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  width: number,
  quality = 70,
  expiresIn = 3600
): Promise<string | null> {
  const { data } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn, { transform: { width, quality } });
  return data?.signedUrl ?? null;
}

export async function signedFull(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  expiresIn = 3600
): Promise<string | null> {
  const { data } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  return data?.signedUrl ?? null;
}

// Download URL — same as signedFull but with `download: true`, which makes
// Supabase set `Content-Disposition: attachment` on the response so the
// browser DOWNLOADS the file instead of navigating to it. This matters because
// the signed URL is cross-origin (Supabase storage host ≠ the app host), and
// the HTML `<a download>` attribute is IGNORED for cross-origin hrefs — an
// `<a download href={signedUrl}>` would silently navigate to the image and
// look broken. The server-side Content-Disposition header is the only reliable
// cross-origin download trigger, and `download: true` is what sets it.
// `signedDownload` returns the SAME kind of signed URL as `signedFull`; the
// difference is purely the response disposition. `filename` (optional) sets the
// downloaded file's name; omit to keep the stored object's original name.
export async function signedDownload(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  expiresIn = 3600,
  filename?: string
): Promise<string | null> {
  const { data } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn, {
      download: filename ? filename : true,
    });
  return data?.signedUrl ?? null;
}