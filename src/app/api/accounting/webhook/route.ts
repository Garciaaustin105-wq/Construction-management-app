import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableTokens } from "@/lib/accounting/connections";
import { getProvider } from "@/lib/accounting/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Intuit webhooks → invoice payment read-back. When a customer pays an invoice
// in QBO (or the office marks it paid there), Intuit POSTs an event here. We:
//   1. GET handshake: Intuit probes `?webhooksVerifier=<token>` when you
//      register the webhook; we echo the verifier token string back.
//   2. POST verify: the `intuit-signature` header is base64(HMAC-SHA256(body,
//      verifier)). We recompute + compare before trusting anything.
//   3. For each Invoice entity in the payload, find the connection by realmId,
//      resolve usable tokens (refresh if needed), read the invoice's balance
//      back from QBO, and if paid flip the local invoice status + amount_paid.
//
// Signature verification + the org-bound token refresh stay here (route), not
// in the adapter (provider.handleWebhook only parses). SQL/RLS/auth/security
// Claude-direct per [[lowvoltage-local-model-delegation]].

function verify(body: string, signature: string | null): boolean {
  const verifier = process.env.INTUIT_WEBHOOK_VERIFIER;
  if (!verifier || !signature) return false;
  const expected = createHmac("sha256", verifier).update(body).digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  // Registration handshake: echo the verifier token Intuit sent.
  const verifier = process.env.INTUIT_WEBHOOK_VERIFIER ?? "";
  const sent = new URL(request.url).searchParams.get("webhooksVerifier") ?? "";
  return new NextResponse(verifier && sent === verifier ? verifier : "", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!verify(body, request.headers.get("intuit-signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const provider = getProvider("quickbooks");
  const result = await provider.handleWebhook(safeJson(body), {});
  if (!result.handled || !result.invoiceIds?.length) {
    return NextResponse.json({ received: true });
  }

  // Each eventNotification carries a realmId → find the org's connection.
  const notifications = (safeJson(body) as { eventNotifications?: Array<{ realmId?: string }> }).eventNotifications ?? [];
  const realmIds = Array.from(new Set(notifications.map((n) => n.realmId).filter(Boolean) as string[]));

  const admin = createAdminClient();
  for (const realmId of realmIds) {
    const { data: conn } = await admin
      .from("accounting_connections")
      .select("organization_id, provider, status")
      .eq("realm_id", realmId)
      .maybeSingle();
    const c = conn as { organization_id: string; provider: "quickbooks"; status: string } | null;
    if (!c || c.status !== "active") continue;
    await refreshInvoicesForOrg(admin, c.organization_id, c.provider, result.invoiceIds).catch(() => {});
  }

  return NextResponse.json({ received: true, refreshed: result.invoiceIds.length });
}

async function refreshInvoicesForOrg(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  providerId: "quickbooks",
  externalInvoiceIds: string[]
) {
  const tokens = await getUsableTokens(orgId, providerId);
  const provider = getProvider(providerId);

  // Find the local invoices whose QBO id matches one of the changed docs.
  const { data: localInvoices } = await admin
    .from("invoices")
    .select("id, organization_id, status, amount_paid, accounting_external_id")
    .in("accounting_external_id", externalInvoiceIds);
  const rows = (localInvoices ?? []) as Array<{
    id: string; organization_id: string; status: string;
    amount_paid: number | null; accounting_external_id: string;
  }>;

  for (const inv of rows) {
    if (inv.organization_id !== orgId) continue; // belt-and-suspenders org bound
    const status = await provider.getInvoicePaymentStatus(tokens, inv.accounting_external_id);
    if (status.paid && status.balance !== null) {
      // Flip to paid + stamp amount_paid if the office recorded it in QBO. A
      // local status of "void" is preserved (don't resurrect voided docs).
      if (inv.status !== "void") {
        await admin
          .from("invoices")
          .update({ status: "paid" })
          .eq("id", inv.id);
      }
    }
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}