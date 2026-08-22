"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Router,
  Save,
  Wifi,
} from "lucide-react";

// The "Internet" tab on a customer: their plan + subscription state, and the
// ISP-specific equipment record. Rendered only for orgs with the module (the
// server page decides), so this component never has to check.
//
// Reads go straight through RLS (office_manage_isp_* policies). WRITES that
// touch Stripe go through /api/isp/* routes, because they need the platform
// Stripe key and the org's connected-account id — neither of which may ever
// reach the browser.

type Plan = { id: string; name: string; price_cents: number; speed_mbps: number | null };

type Subscription = {
  id: string;
  plan_id: string;
  status: string;
  current_period_end: string | null;
  grace_until: string | null;
  stripe_subscription_id: string | null;
};

type Profile = {
  router_rented: boolean;
  router_model: string | null;
  router_serial: string | null;
  router_online: boolean | null;
  router_status_at: string | null;
  static_ip: string | null;
  installed_at: string | null;
  contract_term_months: number | null;
  service_suspended: boolean;
  notes: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  none: "Signing up",
  trialing: "Trial",
  active: "Active",
  past_due: "Payment failed",
  suspended: "Suspended",
  canceled: "Canceled",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function date(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function IspCustomerPanel({
  customerId,
  orgId,
}: {
  customerId: string;
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [selectedPlan, setSelectedPlan] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: planRows }, { data: subRow }, { data: profileRow }] =
      await Promise.all([
        supabase
          .from("isp_plans")
          .select("id, name, price_cents, speed_mbps")
          .eq("active", true)
          .order("position"),
        supabase
          .from("isp_subscriptions")
          .select(
            "id, plan_id, status, current_period_end, grace_until, stripe_subscription_id"
          )
          .eq("customer_id", customerId)
          .in("status", ["none", "trialing", "active", "past_due", "suspended"])
          .maybeSingle(),
        supabase
          .from("isp_customer_profiles")
          .select(
            "router_rented, router_model, router_serial, router_online, router_status_at, static_ip, installed_at, contract_term_months, service_suspended, notes"
          )
          .eq("customer_id", customerId)
          .maybeSingle(),
      ]);

    setPlans((planRows as Plan[]) ?? []);
    setSub((subRow as Subscription | null) ?? null);
    setProfile(
      (profileRow as Profile | null) ?? {
        router_rented: false,
        router_model: null,
        router_serial: null,
        router_online: null,
        router_status_at: null,
        static_ip: null,
        installed_at: null,
        contract_term_months: null,
        service_suspended: false,
        notes: null,
      }
    );
    setLoading(false);
  }, [supabase, customerId]);

  useEffect(() => {
    // Async IIFE so load()'s setState isn't synchronous in the effect body
    // (react-hooks/set-state-in-effect), matching CostCodesManager.
    (async () => {
      await load();
    })();
  }, [load]);

  async function enroll() {
    if (!selectedPlan) {
      toast.warning("Pick a plan first");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/isp/subscriptions/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, planId: selectedPlan }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? "Could not enroll customer");
    } else {
      // Deliberately NOT auto-redirecting: the office user is not the person
      // entering a card. They need the link to hand over.
      setCheckoutUrl(json.checkoutUrl as string);
      toast.success("Sign-up link ready — send it to the customer");
      await load();
    }
    setBusy(false);
  }

  async function openPortal() {
    setBusy(true);
    const res = await fetch("/api/isp/subscriptions/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId }),
    });
    const json = await res.json();
    if (!res.ok) toast.error(json.error ?? "Could not open billing portal");
    else window.open(json.url as string, "_blank", "noopener");
    setBusy(false);
  }

  async function cancel() {
    if (!sub) return;
    if (
      !confirm(
        "Cancel this subscription at the end of the current billing period?\n\n" +
          "The customer keeps service through the period they've already paid for."
      )
    ) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/isp/subscriptions/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId: sub.id }),
    });
    const json = await res.json();
    if (!res.ok) toast.error(json.error ?? "Could not cancel");
    else {
      toast.success("Cancellation scheduled for the end of the period");
      await load();
    }
    setBusy(false);
  }

  async function saveProfile(patch: Partial<Profile>) {
    const next = { ...(profile as Profile), ...patch };
    setProfile(next);
    const { error } = await supabase.from("isp_customer_profiles").upsert(
      {
        organization_id: orgId,
        customer_id: customerId,
        ...next,
      },
      { onConflict: "customer_id" }
    );
    if (error) toast.error(error.message);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  const plan = plans.find((p) => p.id === sub?.plan_id);

  return (
    <div className="space-y-3">
      {/* Subscription */}
      <div className="bg-white rounded-lg p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Wifi className="h-4 w-4 text-slate-400" />
          Service
        </h3>

        {!sub ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-gray-500">Not subscribed to a plan.</p>
            {plans.length === 0 ? (
              <p className="text-xs text-gray-500">
                No active plans yet — add some under Internet Plans first.
              </p>
            ) : (
              <>
                <select
                  value={selectedPlan}
                  onChange={(e) => setSelectedPlan(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">Choose a plan…</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.speed_mbps ? ` · ${p.speed_mbps} Mbps` : ""} —{" "}
                      {money(p.price_cents)}/mo
                    </option>
                  ))}
                </select>
                <button
                  onClick={enroll}
                  disabled={busy}
                  className="w-full px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  {busy ? "Working…" : "Create sign-up link"}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              {sub.status === "active" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : sub.status === "canceled" || sub.status === "none" ? null : (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              <span className="text-sm font-medium text-gray-900">
                {plan?.name ?? "Plan"}
              </span>
              <span className="text-xs text-gray-500">
                {STATUS_LABEL[sub.status] ?? sub.status}
              </span>
            </div>

            <dl className="text-xs text-gray-600 space-y-0.5">
              {plan && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Rate</dt>
                  <dd>{money(plan.price_cents)}/mo</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-gray-400">
                  {sub.status === "canceled" ? "Ends" : "Next bill"}
                </dt>
                <dd>{date(sub.current_period_end)}</dd>
              </div>
              {sub.grace_until && sub.status === "past_due" && (
                <div className="flex justify-between text-amber-700">
                  <dt>Suspends on</dt>
                  <dd>{date(sub.grace_until)}</dd>
                </div>
              )}
            </dl>

            {sub.status === "suspended" && (
              <p className="text-xs text-red-600 bg-red-50 rounded p-2">
                Service suspended for non-payment. It restores automatically as
                soon as a payment goes through.
              </p>
            )}

            {sub.status === "none" && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                Sign-up isn&apos;t finished — the customer hasn&apos;t entered a
                payment method yet.
              </p>
            )}

            <div className="flex gap-2 pt-1">
              {sub.stripe_subscription_id && (
                <button
                  onClick={openPortal}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Billing
                </button>
              )}
              {sub.status !== "canceled" && (
                <button
                  onClick={cancel}
                  disabled={busy}
                  className="px-3 py-2 text-sm text-gray-500 hover:text-red-600"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {checkoutUrl && (
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2">
            <p className="text-xs text-slate-600">
              Send this to the customer to enter their card:
            </p>
            <div className="mt-1 flex items-center gap-2">
              <input
                readOnly
                value={checkoutUrl}
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-slate-200 rounded bg-white"
              />
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(checkoutUrl);
                  toast.success("Copied");
                }}
                className="p-1.5 text-slate-500 hover:text-slate-900"
                aria-label="Copy sign-up link"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Equipment */}
      <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Router className="h-4 w-4 text-slate-400" />
          Equipment
        </h3>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={profile?.router_rented ?? false}
            onChange={(e) => saveProfile({ router_rented: e.target.checked })}
            className="rounded border-gray-300"
          />
          Router rented from us
        </label>

        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            placeholder="Router model"
            defaultValue={profile?.router_model ?? ""}
            onBlur={(e) => saveProfile({ router_model: e.target.value.trim() || null })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            placeholder="Serial number"
            defaultValue={profile?.router_serial ?? ""}
            onBlur={(e) => saveProfile({ router_serial: e.target.value.trim() || null })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            placeholder="Static IP (optional)"
            defaultValue={profile?.static_ip ?? ""}
            onBlur={(e) => saveProfile({ static_ip: e.target.value.trim() || null })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="date"
            defaultValue={profile?.installed_at ?? ""}
            onBlur={(e) => saveProfile({ installed_at: e.target.value || null })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>

        {/* Manual status. Labelled honestly — there is no probe behind this yet,
            so it must not read as live telemetry. */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-3">
          <div>
            <p className="text-sm text-gray-700">Router reported online</p>
            <p className="text-xs text-gray-400">
              Set by hand
              {profile?.router_status_at
                ? ` · as of ${date(profile.router_status_at)}`
                : " · not checked yet"}
            </p>
          </div>
          <button
            onClick={() =>
              saveProfile({
                router_online: !(profile?.router_online ?? false),
                router_status_at: new Date().toISOString(),
              })
            }
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              profile?.router_online
                ? "bg-emerald-100 text-emerald-800"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {profile?.router_online ? "Online" : "Offline"}
          </button>
        </div>

        <textarea
          placeholder="Equipment / service notes"
          defaultValue={profile?.notes ?? ""}
          onBlur={(e) => saveProfile({ notes: e.target.value.trim() || null })}
          rows={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />

        <p className="flex items-center gap-1 text-xs text-gray-400">
          <Save className="h-3 w-3" />
          Changes save when you click away.
        </p>
      </div>
    </div>
  );
}
