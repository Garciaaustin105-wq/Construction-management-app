import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Password-reset CONSUME endpoint. Validates the token from /reset-password
// and sets a new password via the service-role admin API.
//
// Race-safe single-use claim via supabase-js (NOT raw SQL): the chained
// `.update().eq().is().gt().select().maybeSingle()` builds
//   update password_resets set used_at = $now
//   where token_hash = $hash and used_at is null and expires_at > $now
//   returning user_id
// Postgres row-locks the matching row, so two concurrent clicks of the same
// link serialize — exactly one returns the row, the other gets null (the
// used_at is already set). No stored function needed. `.maybeSingle()` yields
// data: null on 0 rows, which we treat as "invalid/expired/used".
//
// The token is POSTed in the body (not a URL), so it isn't re-leaked in a
// Referer/log. The raw token never touches the DB — only its sha256 hash does.

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request) {
  // Consistency with /api/forgot-password, which is rate limited. The reset
  // token itself is 256-bit (randomBytes(32)) so brute force is not the
  // concern — this is defense in depth against submission spam.
  const limited = await checkRateLimit(
    `reset-password:ip:${clientIp(request)}`,
    20,
    60 * 60
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts from this network. Try again later." },
      { status: 429 }
    );
  }

  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400 }
    );
  }

  const token = (body.token ?? "").trim();
  const password = body.password ?? "";

  if (!token) {
    return NextResponse.json(
      { error: "This reset link is invalid, expired, or has already been used." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const hash = sha256Hex(token);
  const now = new Date().toISOString();

  // Atomic single-use claim. The filters (used_at is null, expires_at > now)
  // are part of the WHERE, so an already-used or expired token matches 0 rows
  // and the update is a no-op → maybeSingle() returns data: null.
  const { data, error: claimErr } = await admin
    .from("password_resets")
    .update({ used_at: now })
    .eq("token_hash", hash)
    .is("used_at", null)
    .gt("expires_at", now)
    .select("user_id")
    .maybeSingle();

  if (claimErr) {
    console.error("reset-password: claim failed:", claimErr.message);
    return NextResponse.json(
      { error: "Could not reset your password. Try again." },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: "This reset link is invalid, expired, or has already been used." },
      { status: 400 }
    );
  }

  // Token claimed — set the password with the service role. The claim already
  // marked used_at, so even if this fails the token can't be retried; the user
  // just requests a new link.
  const { error: updErr } = await admin.auth.admin.updateUserById(data.user_id, {
    password,
  });

  if (updErr) {
    console.error("reset-password: updateUserById failed:", updErr.message);
    return NextResponse.json(
      { error: "Could not update your password. Try again or request a new link." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}