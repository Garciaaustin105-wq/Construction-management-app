import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getMyOrg } from "@/lib/tenant";
import { getEffectiveBilling } from "@/lib/billing";
import { isOfficeLike } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { PLAN_TIERS, PAID_TIERS, type PlanTier } from "@/lib/plans";
import BillingForm from "./BillingForm";
import ConnectStripeButton from "./ConnectStripeButton";
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant = await getMyOrg(supabase);
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
  // bookkeeping provider (QuickBooks first). RLS tier_office lets the office
  // user read their own org's connection row directly (session client).
  const { data: accountingRow } = await supabase
    .from("accounting_connections")
    .select("status, metadata")
    .eq("organization_id", tenant.orgId)
    .eq("provider", "quickbooks")
    .maybeSingle();
  const accountingConnected =
    !!accountingRow && (accountingRow as { status: string }).status === "active";
  const accountingStatus = (accountingRow as { status: string } | null)?.status ?? null;
  const accountingMetadata =
    (accountingRow as { metadata: Record<string, unknown> | null } | null)?.metadata ?? null;
  const accountingSection = (
    <AccountingConnectButton
      provider="quickbooks"
      label="QuickBooks Online"
      initialConnected={accountingConnected}
      initialStatus={accountingStatus}
      initialMetadata={accountingMetadata}
    />
  );

  // ── Stripe Connect (Pay Here) ───────────────────────────────────────────────
  // DEPRECATED on construction (payments pivot): construction receivables move
  // to QuickBooks, so the Connect card is hidden on the construction deploy.
  // Lawn keeps it until its provider menu fully replaces it. The cached flags
  // drive the initial render; ConnectStripeButton refreshes them live.
  let connectSection = null;
  if (isLawn()) {
    const { data: orgRow } = await supabase
      .from("organizations")
      .select(
        "stripe_connect_account_id, connect_charges_enabled, connect_details_submitted, connect_payouts_enabled"
      )
      .eq("id", tenant.orgId)
      .maybeSingle();
    connectSection = (
      <ConnectStripeButton
        initialConnectAccountId={
          (orgRow?.stripe_connect_account_id as string) ?? null
        }
        initialChargesEnabled={!!orgRow?.connect_charges_enabled}
        initialDetailsSubmitted={!!orgRow?.connect_details_submitted}
        initialPayoutsEnabled={!!orgRow?.connect_payouts_enabled}
      />
    );
  }

  return (
    <BillingForm
      currentPlan={billing.plan}
      planStatus={billing.planStatus}
      trialDaysLeft={trialDaysLeft}
      isExpired={billing.isExpired}
      hasSubscription={!!billing.stripeSubscriptionId}
      tiers={tiers}
      connectSection={connectSection}
      accountingSection={accountingSection}
    />
  );
}

export type { PlanTier };