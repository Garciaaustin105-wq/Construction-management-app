import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getMe } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";
import { isOfficeLike } from "@/lib/roles";
import { PLAN_TIERS, PAID_TIERS, type PlanTier } from "@/lib/plans";
import { listProviderOptions, getProvider } from "@/lib/accounting/provider";
import "@/lib/accounting/providers"; // registers adapters so listProviderOptions resolves
import BillingForm from "./BillingForm";
import AccountingConnectButton from "./AccountingConnectButton";

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

  return (
    <BillingForm
      currentPlan={billing.plan}
      planStatus={billing.planStatus}
      trialDaysLeft={trialDaysLeft}
      isExpired={billing.isExpired}
      hasSubscription={!!billing.stripeSubscriptionId}
      tiers={tiers}
      accountingSection={accountingSection}
    />
  );
}

export type { PlanTier };