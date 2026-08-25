import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { BookOpen, CreditCard, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getMe } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";
import { isOfficeLike } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { PLAN_TIERS, PAID_TIERS, type PlanTier } from "@/lib/plans";
import { listProviderOptions, getProvider } from "@/lib/accounting/provider";
import "@/lib/accounting/providers"; // registers adapters so listProviderOptions resolves
import BillingForm from "./BillingForm";
import AccountingConnectButton from "./AccountingConnectButton";
import ConnectOnboardingButton from "./ConnectOnboardingButton";

export const dynamic = "force-dynamic";

// Org-admin billing & subscription page. The org admin subscribes to a paid
// tier (Stripe Checkout) or manages an existing subscription (Stripe Customer
// Portal). Non-admins are bounced to the dashboard.

function formatStorage(bytes: number | null): string {
  if (bytes === null) return "Unlimited storage*";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb} GB storage`;
  return `${Math.round(bytes / (1024 * 1024))} MB storage`;
}

export default async function BillingPage() {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) redirect("/login");
  if (!isOfficeLike(tenant.role) || !tenant.orgId) redirect("/dashboard");

  const billing = await getEffectiveBilling(supabase, tenant.orgId);
  if (!billing) redirect("/dashboard");

  // Async server component — runs once per request, so Date.now() is the
  // request time, not a client-render side effect. react-hooks/purity is a
  // false positive here.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const trialDaysLeft = billing.trialEndsAt
    ? Math.max(
        0,
        Math.ceil((new Date(billing.trialEndsAt).getTime() - now) / 86_400_000)
      )
    : null;

  // Only show tiers that have a Stripe price configured (env var set). Tiers
  // without a price (e.g. Business until STRIPE_PRICE_ENTERPRISE_* is set) are
  // hidden from self-serve purchase but remain assignable by super_admin and
  // their caps still apply. Setting the env var later makes the card appear.
  const tiers = PAID_TIERS.filter((t) => PLAN_TIERS[t].priceId).map((t) => {
    const c = PLAN_TIERS[t];
    return {
      tier: t,
      label: c.label,
      blurb: c.blurb,
      maxUsers: c.maxUsers,
      maxJobs: c.maxJobs,
      maxCrewMembers: c.maxCrewMembers,
      maxCustomers: c.maxCustomers,
      maxLineItemsPerDoc: c.maxLineItemsPerDoc,
      storage: formatStorage(c.maxStorageBytes),
      storageCustom: c.storageCustom,
      priceMonthly: c.priceMonthly,
    };
  });

  // ── Bookkeeping integration (payments pivot) ──────────────────────────────
  // The platform never touches customer money; the org connects its OWN
  // bookkeeping provider. The menu is IDENTICAL on both variants (construction
  // + lawn): QuickBooks now, Xero/FreshBooks/Wave/Stripe-BYO as they ship.
  // listProviderOptions() reads the adapter registry populated by the
  // providers.ts side-effect import above, so a newly-registered provider shows
  // up here automatically. RLS tier_office lets the office user read their own
  // org's connection rows directly via the session client; one query returns
  // every row, keyed by provider for the per-card status.
  //
  // `configured` is computed server-side per provider from the adapter (env
  // vars are server-only): when a provider's OAuth client credentials aren't
  // set, the card renders a "Not set up yet" hint instead of looking broken on
  // click. getProvider() never throws here — opt.id comes from the registry.
  const { data: accountingRows } = await supabase
    .from("accounting_connections")
    .select("provider, status, metadata")
    .eq("organization_id", tenant.orgId);
  const byProvider = new Map<
    string,
    { status: string; metadata: Record<string, unknown> | null }
  >();
  for (const r of (accountingRows ?? []) as Array<{
    provider: string;
    status: string;
    metadata: Record<string, unknown> | null;
  }>) {
    byProvider.set(r.provider, { status: r.status, metadata: r.metadata });
  }
  const providerOptions = listProviderOptions();
  const accountingSection = (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-slate-700">
          <BookOpen className="h-5 w-5" />
          <h2 className="text-base font-semibold">Bookkeeping integration</h2>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Connect the bookkeeping app you already use. We sync your customers,
          invoices, and estimates to it — and never touch your customers&apos;
          money. Connect one now and switch any time.
        </p>
      </div>
      {providerOptions.map((opt) => {
        const row = byProvider.get(opt.id);
        return (
          <AccountingConnectButton
            key={opt.id}
            provider={opt.id}
            label={opt.label}
            configured={getProvider(opt.id).isConfigured()}
            initialConnected={row?.status === "active"}
            initialStatus={row?.status ?? null}
            initialMetadata={row?.metadata ?? null}
          />
        );
      })}
    </div>
  );

  // ── Customer online payments (lawn only) ───────────────────────────────────
  // The payments pivot is reversed for lawn, so a lawn org can accept direct-
  // charge invoice payments + autopay via Stripe Connect. This section tells
  // the office the connection state plainly — Phase 1's carried-over orphan:
  // there was nowhere to show WHY payments are off, because nothing consumed
  // the connect status. Construction never offers customer online payments
  // (the pivot holds), so the section is lawn-only.
  //
  // The connect columns are stamped by the account.updated webhook
  // (refreshConnectAccount) and read here directly (RLS session client) rather
  // than calling /api/billing/connect/status — no extra round trip, and the
  // cached values are fresh enough for a settings page. platformLiable fails
  // closed (matches isPlatformLiable): any losses_owner that isn't "stripe" is
  // an account we refuse to use even if Stripe says charges_enabled.
  let customerPaymentsSection: React.ReactNode = null;
  if (isLawn()) {
    const { data: org } = await supabase
      .from("organizations")
      .select(
        "stripe_connect_account_id, connect_charges_enabled, connect_losses_owner, connect_details_submitted"
      )
      .eq("id", tenant.orgId)
      .maybeSingle();
    const connected = !!org?.stripe_connect_account_id;
    const chargesEnabled = !!org?.connect_charges_enabled;
    const platformLiable =
      ((org?.connect_losses_owner as string | null) ?? null) !== "stripe";

    let card: React.ReactNode;
    if (platformLiable) {
      // The live case the doc names (Peanutz L&L: charges_enabled but
      // losses_owner=application). Payments are OFF and the office must see why
      // — not a silently missing button — and be able to reconnect.
      card = (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle className="h-5 w-5" />
            <h2 className="text-base font-semibold">Online payments are off</h2>
          </div>
          <p className="mt-1 text-sm text-amber-800">
            This account was connected under our previous setup, which would
            place chargeback liability on the platform. Online invoice payments
            and autopay are turned off for your customers. Reconnect Stripe to
            enable them.
          </p>
          <div className="mt-3">
            <ConnectOnboardingButton label="Reconnect Stripe" />
          </div>
        </div>
      );
    } else if (!connected || !chargesEnabled) {
      card = (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-slate-700">
            <CreditCard className="h-5 w-5" />
            <h2 className="text-base font-semibold">Accept online payments</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Connect Stripe so customers can pay invoices online and save a card
            for automatic payment of future invoices.
          </p>
          <div className="mt-3">
            <ConnectOnboardingButton label="Connect Stripe" />
          </div>
        </div>
      );
    } else {
      card = (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-2 text-green-800">
            <CheckCircle2 className="h-5 w-5" />
            <h2 className="text-base font-semibold">Online payments are on</h2>
          </div>
          <p className="mt-1 text-sm text-green-800">
            Customers can pay invoices online and save a card for automatic
            payment of future invoices.
          </p>
        </div>
      );
    }
    customerPaymentsSection = <div className="space-y-4">{card}</div>;
  }

  return (
    <BillingForm
      currentPlan={billing.plan}
      planStatus={billing.planStatus}
      trialDaysLeft={trialDaysLeft}
      isExpired={billing.isExpired}
      hasSubscription={!!billing.stripeSubscriptionId}
      tiers={tiers}
      accountingSection={accountingSection}
      customerPaymentsSection={customerPaymentsSection}
    />
  );
}

export type { PlanTier };