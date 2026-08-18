import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";
import { isOfficeLike } from "@/lib/roles";
import { getConnection } from "@/lib/accounting/connections";
import type { AccountingProviderId } from "@/lib/accounting/provider";

export const dynamic = "force-dynamic";

// Read the org's accounting connection status for a provider. Office/admin
// only. Returns whether the org is connected + the provider + a refreshed-at
// hint. Also probes token health by attempting a usable-token resolve only when
// `probe=true` (off by default to avoid a refresh on every billing-page load).

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const tenant = await getMyOrg(supabase);
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role) || !tenant.orgId) {
    return NextResponse.json(
      { error: "Only an organization admin can view bookkeeping setup" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    provider?: string;
    probe?: boolean;
  };
  const providerId = (body.provider ?? "quickbooks") as AccountingProviderId;
  if (!["quickbooks", "xero", "freshbooks", "wave", "stripe_byo"].includes(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const conn = await getConnection(tenant.orgId, providerId);
  if (!conn || conn.status !== "active") {
    return NextResponse.json({ connected: false, provider: providerId, status: conn?.status ?? null });
  }

  let tokenHealthy = true;
  if (body.probe) {
    // getUsableTokens refreshes if near expiry; throws if the refresh token
    // itself is dead (→ we mark the row expired so the UI shows "reconnect").
    const { getUsableTokens, setStatus } = await import("@/lib/accounting/connections");
    try {
      await getUsableTokens(tenant.orgId, providerId);
    } catch {
      tokenHealthy = false;
      await setStatus(tenant.orgId, providerId, "expired").catch(() => {});
    }
  }

  return NextResponse.json({
    connected: true,
    provider: providerId,
    status: conn.status,
    realmId: conn.realm_id,
    metadata: conn.metadata,
    accessExpiresAt: conn.access_expires_at,
    refreshExpiresAt: conn.refresh_expires_at,
    tokenHealthy,
  });
}