import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Public review-feedback submit. The customer reaches /r/{token} (the rating
// gate intercept page) from a review_request email/SMS, picks 1-5 stars, and
// optionally leaves feedback. This route stores the rating + feedback on the
// review_requests row and — for an UNHAPPY rating (1-3★) — drops a
// `review_feedback` notification into the office feed so the office can follow
// up before the customer vents publicly. A happy rating (4-5★) returns the
// org's Google Business Profile URL so the gate page can offer a public review.
//
// No auth — the `token` in the body is the sole credential (mirrors
// lawn_visits.share_token / the /v portal / /api/leads). Service-role (bypasses
// RLS): this is the ONE trusted write boundary for public review feedback;
// office CRUD on review_requests happens client-side through RLS
// (tier_office_or_pm). Validate token + rating strictly here.
//
// Variant-neutral: resolves by token, not build variant. The status route only
// mints review_requests rows for paid LAWN orgs today, but the resolver is
// token-based so construction opts in later with zero rewrite. Builds clean on
// both deploys.

export async function POST(request: Request) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured" },
      { status: 500 }
    );
  }

  // Public unauthenticated POST — throttle to bound junk rows. The honeypot
  // below catches naive bots; this bounds everything else.
  const limited = await checkRateLimit(
    `review-feedback:ip:${clientIp(request)}`,
    20,
    60 * 60
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Honeypot: a real user never fills the hidden "company_website" field. Bots
  // do. Pretend success so the trap isn't revealed, but do nothing.
  const honeypot = body.company_website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    return NextResponse.json({ ok: true }, { status: 201 });
  }

  const token =
    typeof body.token === "string" ? body.token.trim() : "";
  const ratingNum =
    typeof body.rating === "number" ? body.rating : Number(body.rating);
  const feedback =
    typeof body.feedback === "string" ? body.feedback.trim().slice(0, 2000) : "";

  if (!token) {
    return NextResponse.json({ error: "Invalid link" }, { status: 400 });
  }
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return NextResponse.json({ error: "A rating from 1 to 5 is required" }, { status: 400 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // 1) Resolve the review request by its unguessable token.
  const { data: rrRow } = await admin
    .from("review_requests")
    .select("id, organization_id, customer_id, status")
    .eq("token", token)
    .maybeSingle();
  const rr = rrRow as unknown as {
    id: string;
    organization_id: string;
    customer_id: string | null;
    status: string;
  } | null;
  if (!rr) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // 2) Store the rating + feedback. status: 4-5★ = happy, 1-3★ = unhappy.
  //    Idempotent re-submit: a second submit overwrites the row (the customer
  //    may change their mind before leaving the page). completed_at stamps now.
  const happy = ratingNum >= 4;
  const newStatus = happy ? "happy" : "unhappy";
  const { error: updateError } = await admin
    .from("review_requests")
    .update({
      rating: ratingNum,
      feedback: feedback || null,
      status: newStatus,
      completed_at: new Date().toISOString(),
    })
    .eq("id", rr.id);
  if (updateError) {
    return NextResponse.json(
      { error: `Could not submit: ${updateError.message}` },
      { status: 500 }
    );
  }

  // 2b) Optional customer photo (item 16). The body may carry a base64 JPEG/PNG
  //     (≤ ~2.5 MB encoded); it lands in the private job-photos bucket under
  //     review-photos/{reviewRequestId}/ and gets a photos row linked via
  //     photos.review_request_id. STRICTLY non-fatal: a bad/failed upload never
  //     blocks the rating, which is already stored. Magic-byte checked — we
  //     never trust a claimed content type.
  const photoB64 =
    typeof body.photo === "string" && body.photo.length > 0 && body.photo.length <= 3_500_000
      ? body.photo
      : null;
  if (photoB64) {
    try {
      const buf = Buffer.from(photoB64, "base64");
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isPng =
        buf.length > 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      if (isJpeg || isPng) {
        const ext = isJpeg ? "jpg" : "png";
        const path = `review-photos/${rr.id}/${Date.now()}.${ext}`;
        const up = await admin.storage
          .from("job-photos")
          .upload(path, buf, { contentType: isJpeg ? "image/jpeg" : "image/png" });
        if (!up.error) {
          await admin.from("photos").insert({
            organization_id: rr.organization_id,
            storage_path: path,
            caption: "Customer review photo",
            review_request_id: rr.id,
          });
        }
      }
    } catch {
      // Swallow — photo attach is optional garnish.
    }
  }

  // 3) For an unhappy rating (or any feedback left), notify the office so they
  //    can follow up before the customer goes public. Best-effort, never fatal.
  //    unique (type, entity_id) → onConflict ignore is harmless (one nudge per
  //    review request). Mirrors the new_lead upsert in /api/leads.
  if (!happy || feedback) {
    try {
      let customerName: string | null = null;
      if (rr.customer_id) {
        const { data: cust } = await admin
          .from("customers")
          .select("name")
          .eq("id", rr.customer_id)
          .maybeSingle();
        customerName =
          (cust as unknown as { name: string | null } | null)?.name ?? null;
      }
      await admin.from("notifications").upsert(
        {
          organization_id: rr.organization_id,
          type: "review_feedback",
          title: happy ? "Review feedback" : "Negative review feedback",
          body: [customerName, `${ratingNum}★`, feedback].filter(Boolean).join(" · ") || `${ratingNum}★`,
          entity_id: rr.id,
          href: "/admin/reviews",
        },
        { onConflict: "type,entity_id", ignoreDuplicates: true }
      );
    } catch {
      // Swallow — the feed is best-effort; the rating is already stored.
    }
  }

  // 4) For a happy rating, return the org's configured review-platform
  //    destinations (review_platforms table, item 14) so the gate page can
  //    offer the customer a choice. Falls back to the legacy
  //    notification_settings.google_review_url when the org hasn't set any
  //    platforms up, and to null when neither exists (the page degrades).
  let platforms: { platform: string; review_url: string }[] = [];
  if (happy) {
    const { data: platformRows } = await admin
      .from("review_platforms")
      .select("platform, review_url")
      .eq("organization_id", rr.organization_id)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(8);
    platforms =
      (platformRows as unknown as { platform: string; review_url: string }[] | null)
        ?.filter((p) => p.review_url?.trim())
        .map((p) => ({ platform: p.platform, review_url: p.review_url.trim() })) ??
      [];
    if (platforms.length === 0) {
      const { data: settings } = await admin
        .from("notification_settings")
        .select("google_review_url")
        .eq("organization_id", rr.organization_id)
        .maybeSingle();
      const googleUrl =
        (settings as unknown as { google_review_url: string | null } | null)?.google_review_url?.trim() ||
        null;
      if (googleUrl) platforms = [{ platform: "google", review_url: googleUrl }];
    }
  }

  return NextResponse.json(
    { ok: true, status: newStatus, platforms },
    { status: 201 }
  );
}

export function GET() {
  // Public endpoint exists for POST only; a GET is a probe. Respond plainly.
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}