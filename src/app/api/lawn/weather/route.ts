import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";
import { getLawnWeatherBoard } from "@/lib/lawnWeather";

// GET /api/lawn/weather — NWS forecast for the org's pending lawn visits.
// Office-only (office / admin / super_admin). RLS scopes reads to this org.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = me.role;
  if (!OFFICE_LIKE.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const board = await getLawnWeatherBoard(supabase);
  return NextResponse.json(board);
}