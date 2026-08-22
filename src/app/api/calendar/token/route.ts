import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { requireOrgScoped } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// Manage the caller's personal iCal subscribe feed row.
//   POST                   → ensure a feed row exists; return the subscribe URL.
//   POST { rotate: true }  → regenerate the token (invalidates the old URL).
//   DELETE                 → revoke the feed (the old URL 404s).
//
// Any signed-in org-scoped user may have a feed (crew/customer included — the
// feed itself enforces role-based content). super_admin must target an org
// (requireOrgScoped), which is fine: a platform account with no org has nothing
// personal to subscribe to.

// Build the public subscribe URL from the incoming request host so it works in
// preview deploys + production without an env var.
function feedUrl(host: string, token: string): string {
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}/api/calendar/feed?token=${token}`;
}

function requestHost(request: Request): string {
  // Vercel sets x-forwarded-host; fall back to the Host header then the URL.
  const xfhost = request.headers.get("x-forwarded-host");
  if (xfhost) return xfhost;
  const hostHeader = request.headers.get("host");
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host;
  } catch {
    return "localhost";
  }
}

export async function POST(request: Request) {
  // One cached identity read (shared with the root layout) instead of
  // getUser() + requireOrgScoped()'s own getUser() + profiles + organizations.
  const scoped = await requireOrgScoped();
  if (!scoped.ok) {
    return NextResponse.json(
      { error: scoped.error },
      { status: scoped.status }
    );
  }
  const tenant = scoped.tenant;
  const user = tenant.user;

  let rotate = false;
  try {
    const body = await request.json();
    rotate = !!body?.rotate;
  } catch {
    // empty / non-JSON body is fine — just means "ensure exists"
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Look up the existing feed row (service role — the RLS policy would also
  // allow this via the browser client, but we need the service role to insert
  // with an explicit organization_id and to regenerate the token).
  const { data: existing } = await admin
    .from("calendar_feeds")
    .select("id, token")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing && !rotate) {
    return NextResponse.json({
      url: feedUrl(requestHost(request), existing.token),
    });
  }

  if (existing && rotate) {
    // Regenerate the token (gen_random_uuid server-side via .update with a
    // fresh value). Supabase JS has no uuid() helper, so generate one here.
    const newToken = crypto.randomUUID();
    const { error } = await admin
      .from("calendar_feeds")
      .update({ token: newToken })
      .eq("id", existing.id);
    if (error) {
      return NextResponse.json(
        { error: `Rotate failed: ${error.message}` },
        { status: 500 }
      );
    }
    return NextResponse.json({
      url: feedUrl(requestHost(request), newToken),
    });
  }

  // No row yet — create one. organization_id comes from the caller's tenant
  // (NOT from the request body) so a user can't mint a feed for another org.
  const token = crypto.randomUUID();
  const { data: row, error } = await admin
    .from("calendar_feeds")
    .insert({
      user_id: user.id,
      organization_id: tenant.orgId,
      token,
    })
    .select("token")
    .single();

  if (error || !row) {
    return NextResponse.json(
      { error: `Create failed: ${error?.message ?? "no row returned"}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    url: feedUrl(requestHost(request), row.token),
  });
}

export async function DELETE() {
  // One cached identity read (shared with the root layout) instead of
  // getUser() + requireOrgScoped()'s own getUser() + profiles + organizations.
  const scoped = await requireOrgScoped();
  if (!scoped.ok) {
    return NextResponse.json(
      { error: scoped.error },
      { status: scoped.status }
    );
  }
  const user = scoped.tenant.user;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Delete only the caller's own row (scoped by user_id). on delete cascade is
  // redundant here but the row is gone either way → the feed URL 404s.
  const { error } = await admin
    .from("calendar_feeds")
    .delete()
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json(
      { error: `Revoke failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}