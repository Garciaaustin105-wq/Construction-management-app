"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Trash2, Wifi, AlertTriangle } from "lucide-react";

// The org's fiber/ISP plan catalog. Mirrors CostCodesManager's shape (RLS-direct
// client writes, office-gated by office_manage_isp_plans) — no API route needed,
// because nothing here touches Stripe.
//
// THE ONE NON-OBVIOUS RULE, surfaced in the UI rather than hidden:
// Stripe Prices are immutable. Editing a plan's price cannot reprice existing
// subscribers; it only changes what NEW enrollments pay. Saving a new price
// clears stripe_price_id so the next enrollment mints a fresh Stripe Price on
// the org's connected account. Existing subscribers keep billing at the old
// amount until someone moves them deliberately. Users who don't know this
// assume "change price" means "change everyone's price," so the form says so.

type IspPlan = {
  id: string;
  name: string;
  speed_mbps: number | null;
  price_cents: number;
  setup_fee_cents: number;
  position: number;
  active: boolean;
  stripe_price_id: string | null;
};

const COLS =
  "id, name, speed_mbps, price_cents, setup_fee_cents, position, active, stripe_price_id";

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseDollars(v: string): number | null {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default function IspPlansManager({ orgId }: { orgId: string }) {
  const supabase = createClient();
  const toast = useToast();
  const [plans, setPlans] = useState<IspPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [speed, setSpeed] = useState("");
  const [price, setPrice] = useState("");
  const [setupFee, setSetupFee] = useState("");

  async function load() {
    const { data } = await supabase
      .from("isp_plans")
      .select(COLS)
      .order("position")
      .order("name");
    setPlans((data as IspPlan[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      toast.warning("Plan name is required");
      return;
    }
    const cents = parseDollars(price);
    if (cents === null) {
      toast.warning("Enter a monthly price");
      return;
    }
    const setupCents = setupFee.trim() ? parseDollars(setupFee) : 0;
    if (setupCents === null) {
      toast.warning("Setup fee isn't a valid amount");
      return;
    }
    const speedVal = speed.trim() ? Number(speed.trim()) : null;
    if (speedVal !== null && !Number.isFinite(speedVal)) {
      toast.warning("Speed must be a number (Mbps)");
      return;
    }

    setSaving(true);
    const { error } = await supabase.from("isp_plans").insert({
      organization_id: orgId,
      name: n,
      speed_mbps: speedVal,
      price_cents: cents,
      setup_fee_cents: setupCents,
      position: plans.length,
    });
    if (error) {
      toast.error(
        error.code === "23505" ? "A plan with that name already exists" : error.message
      );
    } else {
      toast.success("Plan added");
      setName("");
      setSpeed("");
      setPrice("");
      setSetupFee("");
      await load();
    }
    setSaving(false);
  }

  async function savePrice(plan: IspPlan, raw: string) {
    const cents = parseDollars(raw);
    if (cents === null || cents === plan.price_cents) return;

    if (
      plan.stripe_price_id &&
      !confirm(
        `Change "${plan.name}" from $${dollars(plan.price_cents)} to $${dollars(cents)}/mo?\n\n` +
          `This applies to NEW sign-ups only. Customers already on this plan keep paying ` +
          `$${dollars(plan.price_cents)} until you move them individually.`
      )
    ) {
      return;
    }

    // Clearing stripe_price_id is the whole point: it forces the next
    // enrollment to create a fresh (immutable) Stripe Price at the new amount.
    const { error } = await supabase
      .from("isp_plans")
      .update({ price_cents: cents, stripe_price_id: null })
      .eq("id", plan.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Price updated for new sign-ups");
      await load();
    }
  }

  async function toggleActive(plan: IspPlan) {
    const { error } = await supabase
      .from("isp_plans")
      .update({ active: !plan.active })
      .eq("id", plan.id);
    if (error) {
      toast.error(error.message);
    } else {
      setPlans((prev) =>
        prev.map((p) => (p.id === plan.id ? { ...p, active: !p.active } : p))
      );
    }
  }

  async function remove(plan: IspPlan) {
    if (
      !confirm(
        `Delete "${plan.name}"?\n\nIf anyone is subscribed to it this will fail — ` +
          `deactivate it instead to hide it from new sign-ups.`
      )
    ) {
      return;
    }
    const { error } = await supabase.from("isp_plans").delete().eq("id", plan.id);
    if (error) {
      // 23503 = FK violation from isp_subscriptions.plan_id (on delete restrict).
      toast.error(
        error.code === "23503"
          ? "Customers are subscribed to this plan. Deactivate it instead."
          : error.message
      );
    } else {
      toast.success("Deleted");
      setPlans((prev) => prev.filter((p) => p.id !== plan.id));
    }
  }

  return (
    <section className="space-y-4">
      <form onSubmit={add} className="bg-white rounded-lg p-3 shadow-sm space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Plan name (e.g. 1G Fiber)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            inputMode="numeric"
            placeholder="Mbps"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
            className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="Monthly price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            inputMode="decimal"
            placeholder="Setup fee (optional)"
            value={setupFee}
            onChange={(e) => setSetupFee(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add plan
        </button>
      </form>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      ) : plans.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">
          No plans yet. Add the packages you sell — customers get enrolled onto
          one of these.
        </p>
      ) : (
        <ul className="space-y-2">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className={`bg-white rounded-lg p-3 shadow-sm ${plan.active ? "" : "opacity-60"}`}
            >
              <div className="flex items-start gap-3">
                <Wifi className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 truncate">
                    {plan.name}
                    {plan.speed_mbps ? (
                      <span className="text-gray-500 font-normal">
                        {" "}
                        · {plan.speed_mbps} Mbps
                      </span>
                    ) : null}
                    {!plan.active && (
                      <span className="ml-2 text-xs text-gray-500">(inactive)</span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-gray-500">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      defaultValue={dollars(plan.price_cents)}
                      onBlur={(e) => savePrice(plan, e.target.value)}
                      className="w-24 px-2 py-1 border border-gray-200 rounded text-sm"
                    />
                    <span className="text-xs text-gray-500">/mo</span>
                    {plan.setup_fee_cents > 0 && (
                      <span className="text-xs text-gray-500">
                        + ${dollars(plan.setup_fee_cents)} setup
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    onClick={() => toggleActive(plan)}
                    className="text-xs text-slate-600 hover:underline"
                  >
                    {plan.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    onClick={() => remove(plan)}
                    className="text-gray-400 hover:text-red-600"
                    aria-label={`Delete ${plan.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {plans.some((p) => p.stripe_price_id) && (
        <p className="flex items-start gap-2 text-xs text-gray-500 px-1">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span>
            Changing a price affects new sign-ups only. Customers already on a
            plan keep their current rate until you move them.
          </span>
        </p>
      )}
    </section>
  );
}
