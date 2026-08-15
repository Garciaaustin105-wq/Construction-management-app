import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";
import { sendPasswordResetEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

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
// Rate limit: in-memory per-IP, 5/hour (same shape as /api/signup). Resets on
// cold start and isn't shared across serverless instances — fine for now; swap
// in Upstash Ratelimit when shared limits are needed.

const resetHits = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (resetHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (hits.length >= RATE_LIMIT_MAX) {
    resetHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  resetHits.set(ip, hits);
  return false;
}

function clientIp(request: Request): string {
  const xfwd = request.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  return "unknown";
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (rateLimited(ip)) {
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
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", mail)
    .maybeSingle();

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
        return NextResponse.json(
          { error: "Could not send the reset email. Try again or contact support." },
          { status: 500 }
        );
      }
    } catch (err) {
      console.error(
        "forgot-password: send threw:",
        err instanceof Error ? err.message : err
      );
      return NextResponse.json(
        { error: "Could not send the reset email. Try again or contact support." },
        { status: 500 }
      );
    }
  }

  // Generic success regardless of whether an account exists (no enumeration).
  return NextResponse.json({ ok: true }, { status: 200 });
}