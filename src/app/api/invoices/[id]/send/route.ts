import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { deliverInvoice, type InvoiceChannel } from "@/lib/invoiceSend";

export const dynamic = "force-dynamic";

// Send (or resend) an invoice to its customer. Auth: the signed-in user must be
// office/admin/project_manager OR the owning customer (profiles.customer_id ===
// invoice.customer_id) — the latter is how the logged-in customer-approve path
// triggers the auto-send after approve_estimate returns the invoice id. The
// public /q/{token} approve path does NOT use this route; it calls deliverInvoice
// inline (no session to authorize here).
//
// `via` selects the channel: "email", "sms", "both", or "auto" (default) —
// "auto" delivers via whichever contact field the customer has on file, which is
// the auto-send behavior used after approval. The route always returns 200 with
// a `delivered` flag + `warnings` (e.g. "email not configured" while Resend is
// pending) so callers can surface partial/no delivery gracefully without a hard
// error — approval already succeeded, so a not-yet-configured channel shouldn't
// read as a failure.

function requestOrigin(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  const host =
    xfhost ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let via: "email" | "sms" | "both" | "auto" = "auto";
  try {
    const body = await request.json();
    if (
      body?.via === "email" ||
      body?.via === "sms" ||
      body?.via === "both" ||
      body?.via === "auto"
    ) {
      via = body.via;
    }
  } catch {
    // No body / invalid JSON is fine — via stays "auto".
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, customer_id")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  // RLS scopes this read to the caller's org (office/PM) or their own invoices
  // (customer). A row the caller can't see → 404.
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, customer_id")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const isOfficeLike =
    role === "office" || role === "admin" || role === "project_manager";
  const isOwningCustomer =
    !!profile?.customer_id && profile.customer_id === invoice.customer_id;
  if (!isOfficeLike && !isOwningCustomer) {
    return NextResponse.json(
      { error: "Not authorized to send this invoice" },
      { status: 403 }
    );
  }

  const result = await deliverInvoice(id, {
    origin: requestOrigin(request),
    via: via === "auto" ? undefined : (via as InvoiceChannel),
  });

  return NextResponse.json({
    ok: result.delivered,
    delivered: result.delivered,
    sentVia: result.sentVia,
    sentTo: result.sentTo,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  });
}