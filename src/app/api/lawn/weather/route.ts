import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";
import { getLawnWeatherBoard } from "@/lib/lawnWeather";

// GET /api/lawn/weather — NWS forecast for the org's pending lawn visits.
// Office-only (office / admin / super_admin). RLS scopes reads to this org.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_LIKE.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const board = await getLawnWeatherBoard(supabase);
  return NextResponse.json(board);
}