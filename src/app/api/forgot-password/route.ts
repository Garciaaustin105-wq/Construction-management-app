import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";
import { sendPasswordResetEmail } from "@/lib/email";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
// redeploy trigger 2

// Password-reset REQUEST endpoint. Mints a single-use, 15-minute bearer token
// whose sha256 hash is stored in public.password_resets, and emails a link to
// https://<origin>/reset-password?token=<raw> via Resend.
//
// Why custom (not Supabase's resetPasswordForEmail): Supabase's recovery link
// is PKCE — the email carries only a `code` and finishing needs a
// code_verifier COOKIE on the device that requested the reset. Click it on
// another device / browser / the installed PWA and it fails. Here the proof is
// ENTIRELY in the link, so it works cross-device. See password_resets.sql.
//
// No-existence-leak: we ALWAYS return the same generic 200 whether or not the
// email has an account, so this endpoint can't be used to enumerate accounts.
// (A timing gap exists — the found path does an insert + email send — but it's
// low-severity for this app; the rate limit is the main abuse control.)
//
// Rate limit: per-IP, 5/hour, via the SHARED Postgres-backed limiter
// (src/lib/rateLimit.ts). This used to be a module-level in-memory Map, which
// on Vercel is per-serverless-instance and ephemeral — concurrent requests hit
// different instances and instances recycle, so the real cap was roughly
// `5 x instance count` and reset unpredictably. The shared counter fixes that.

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request) {
  const limited = await checkRateLimit(
    `forgot-password:ip:${clientIp(request)}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many reset requests from this network. Try again later." },
      { status: 429 }
    );
  }

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: true }, // generic — don't reveal shape errors
      { status: 200 }
    );
  }
  const mail = (body.email ?? "").trim().toLowerCase();
  if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
    // Still 200 + generic to avoid leaking which emails are valid.
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve the account by email via profiles (profiles.id == auth.users.id).
  // CASE-INSENSITIVE: profiles.email may be stored mixed-case (e.g. an
  // admin-created "Austin@..." row), and we lowercased the input above. A plain
  // .eq is case-sensitive in Postgres, so "austin@..." would miss "Austin@..."
  // and the route would silently no-op (generic 200, no email sent) — which
  // looked exactly like "the email never arrived." ilike matches
  // case-insensitively; escape the ILIKE wildcards so _ / % in an email local
  // part can't widen the match.
  const { data: profiles } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", mail.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/%/g, "\\%"))
    .limit(1);
  const profile = profiles?.[0] ?? null;

  if (profile) {
    // Resend is REQUIRED for this flow — Supabase's built-in sender can't carry
    // our custom token link, and falling back to its PKCE link would reintroduce
    // the exact cross-device bug this fixes. Fail loudly rather than silently
    // degrade.
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
      console.error(
        "forgot-password: RESEND_API_KEY/RESEND_FROM not set — cannot send custom reset email."
      );
      return NextResponse.json(
        { error: "Password reset email is not configured. Contact your administrator." },
        { status: 500 }
      );
    }

    const token = randomBytes(32).toString("hex"); // 256-bit
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { error: insertErr } = await admin.from("password_resets").insert({
      user_id: profile.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (insertErr) {
      console.error("forgot-password: insert failed:", insertErr.message);
      return NextResponse.json(
        { error: "Could not create a reset link. Try again." },
        { status: 500 }
      );
    }

    const origin = new URL(request.url).origin;
    const resetLink = `${origin}/reset-password?token=${token}`;

    try {
      const result = await sendPasswordResetEmail({ to: mail, resetLink });
      if (result.error) {
        console.error("forgot-password: Resend rejected:", result.error.message);
        // TEMP DIAGNOSTIC: surface the provider's rejection reason so we can
        // see why delivery fails (env vars are masked in Vercel). Resend error
        // messages do not contain the API key. Trim once resolved.
        return NextResponse.json(
          {
            error: `Email provider rejected the send: ${result.error.message}`,
          },
          { status: 500 }
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("forgot-password: send threw:", msg);
      return NextResponse.json(
        { error: `Email send failed: ${msg}` },
        { status: 500 }
      );
    }
  }

  // Generic success regardless of whether an account exists (no enumeration).
  return NextResponse.json({ ok: true }, { status: 200 });
}