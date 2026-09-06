import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { OFFICE_OR_PM } from "@/lib/roles";
import type { Role } from "@/lib/roles";
import { applySuggestion } from "@/lib/crewFeedbackData";

// Applies ONE accepted rate suggestion to the catalogue it came from.
//
// One row per request, on purpose. There is no "apply all": the whole point of
// the feedback screen is that a person looks at the sample size and the spread
// and decides about that specific rate. A bulk endpoint would quietly undo
// that, and would let one bad week rewrite the whole catalogue.
//
// Gate: OFFICE_OR_PM, matching the office policies on every catalogue this can
// write to (role-gate-mismatch pattern). getMe rather than requireRole because
// requireRole REDIRECTS, which is right for a page and wrong for fetch — a 302
// to /dashboard would reach the client as an opaque success.
// RLS enforces the same rule again on the way through, so a crew token cannot
// reach these rows even if this check were wrong.

export async function POST(request: Request) {
  const me = await getMe();
  if (!me) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!OFFICE_OR_PM.has(me.role as Role) || !me.orgId) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const { key, rate } = (body ?? {}) as { key?: unknown; rate?: unknown };
  if (typeof key !== "string" || !key) {
    return NextResponse.json({ error: "Which row?" }, { status: 400 });
  }
  const value = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: "That is not a usable rate." }, { status: 400 });
  }

  const supabase = await createClient();
  const error = await applySuggestion(supabase, key, value);
  if (error) return NextResponse.json({ error }, { status: 400 });

  return NextResponse.json({ ok: true });
}
