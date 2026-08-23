import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";
import { checkAiQuota } from "@/lib/aiQuota";

export const dynamic = "force-dynamic";

// GET /api/ai/quota — the caller's org AI-action usage this calendar month.
//
// Browser half of the contract: src/lib/aiClient.ts (fetchAiQuota). The JSON
// returned here mirrors the `AiQuota` interface in src/lib/aiQuota.ts EXACTLY
// ({ allowed, used, max }) — aiClient.ts re-declares it for the same reason:
// aiQuota.ts is server-only (it reads the service-role key), so the client
// can't import it and must read quota through this route.
//
// Auth: getMe (session). An org id is required — super_admin / null-org accounts
// have no per-org quota, so they get 403. checkAiQuota() uses the service role
// internally (contained in aiQuota.ts) to read the org's cap + monthly count;
// that key never crosses into the response.

export async function GET() {
  const me = await getMe();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!me.orgId) {
    return NextResponse.json(
      { error: "Your account has no organization." },
      { status: 403 }
    );
  }
  const quota = await checkAiQuota(me.orgId);
  return NextResponse.json(quota);
}