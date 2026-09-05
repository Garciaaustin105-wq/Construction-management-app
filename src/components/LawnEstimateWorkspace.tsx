"use client";

// Lawn estimating workspace (client). One estimate, two tabs:
//   Measure — LawnMeasurementMap full width (it has its own internal sidebar
//             and needs the room the shared ~600px estimate column can't give)
//   Items   — the line-item strip, full size
// plus a compact always-visible strip on the Measure tab so the running total
// moves as areas are priced, not after you leave.
//
// Line-item persistence FOLLOWS the shared page's save path
// (/estimates/[id]/page.tsx saveEstimate): read all rows, append, delete the
// estimate's items, reinsert with fresh positions and the same column mapping
// (recurring_schedule_id intentionally NOT re-inserted — route-stamp only).
// Same guards too: only draft estimates accept writes. RLS scopes every query
// — no manual organization_id filters.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronUp, FileText, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import LawnMeasurementMap from "@/components/LawnMeasurementMap";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ESTIMATE_STATUS_LABEL,
  ESTIMATE_STATUS_TONE,
  type EstimateStatus,
} from "@/lib/lifecycles/estimate";
import {
  computeEstimateTotals,
  computeTotal,
  formatMoney,
} from "@/lib/money";

// Same office line-item columns the shared page reads so a rewrite here
// round-trips exactly what saveEstimate would have written back.
const ITEM_SELECT =
  "id, cost_code_id, description, quantity, unit, unit_price, internal_cost, section, schedule_frequency, schedule_interval_weeks, schedule_days_of_week, schedule_day_of_month, schedule_start_date, schedule_end_date, recurring_schedule_id";

type LineRow = {
  id: string;
  cost_code_id: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  internal_cost: number | null;
  section: string | null;
  schedule_frequency?: string | null;
  schedule_interval_weeks?: number;
  schedule_days_of_week?: number[];
  schedule_day_of_month?: number | null;
  schedule_start_date?: string | null;
  schedule_end_date?: string | null;
  recurring_schedule_id?: string | null;
};

type Estimate = {
  id: string;
  title: string | null;
  status: string;
  markup_pct: number;
  contingency_pct: number;
  tax_pct: number;
  deposit_pct: number;
  deposit_amount: number;
  jobs: { name: string; address: string | null } | null;
  customers: { name: string | null; address: string | null } | null;
};

export default function LawnEstimateWorkspace({
  estimateId,
}: {
  estimateId: string;
}): React.ReactElement {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [items, setItems] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"measure" | "items">("measure");
  const [stripOpen, setStripOpen] = useState(false);
  const [persisting, setPersisting] = useState(false);

  const toast = useToast();

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      // RLS scopes both reads to the caller's org — a foreign estimate id
      // simply comes back empty.
      const [{ data: est }, { data: rows }] = await Promise.all([
        supabase
          .from("estimates")
          .select(
            "id, title, status, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, jobs(name, address), customers(name, address)"
          )
          .eq("id", estimateId)
          .maybeSingle(),
        supabase
          .from("estimate_line_items")
          .select(ITEM_SELECT)
          .eq("estimate_id", estimateId)
          .order("position"),
      ]);
      if (!est) {
        toast.error("Estimate not found");
        setLoading(false);
        return;
      }
      setEstimate(est as unknown as Estimate);
      setItems((rows as LineRow[] | null) ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId]);

  // ── Persist a map-priced line ──────────────────────────────────────────────
  // The shared page's write (saveEstimate): delete + reinsert everything with
  // fresh positions. We read fresh from the DB first so a line priced here
  // never clobbers rows the office added on the document page.
  async function addMeasuredLine(line: {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
  }) {
    if (!estimate || persisting) return;
    // Same guards as the shared page's saveEstimate — a converted estimate is
    // locked (the delete+reinsert would wipe the line→schedule stamp), and
    // only drafts accept writes.
    if (estimate.status === "converted") {
      toast.warning("This estimate is converted. Edit the schedules directly.");
      return;
    }
    if (estimate.status !== "draft") {
      toast.warning(
        "Only draft estimates can be edited. Use Revise to edit a sent or rejected estimate."
      );
      return;
    }
    setPersisting(true);
    const supabase = createClient();
    const { data: rows, error: readError } = await supabase
      .from("estimate_line_items")
      .select(ITEM_SELECT)
      .eq("estimate_id", estimate.id)
      .order("position");
    if (readError) {
      toast.error(`Save failed: ${readError.message}`);
      setPersisting(false);
      return;
    }
    const existing = (rows as LineRow[] | null) ?? [];
    const all: LineRow[] = [
      ...existing,
      {
        id: `pending-${Date.now()}`,
        cost_code_id: null,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        internal_cost: null,
        section: "",
      },
    ];

    const { error: deleteError } = await supabase
      .from("estimate_line_items")
      .delete()
      .eq("estimate_id", estimate.id);
    if (deleteError) {
      toast.error(`Save failed: ${deleteError.message}`);
      setPersisting(false);
      return;
    }
    // Same insert mapping as the shared page's saveEstimate.
    const lineInserts = all.map((item, idx) => ({
      estimate_id: estimate.id,
      cost_code_id: item.cost_code_id ?? null,
      description: (item.description ?? "").trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      section: item.section || null,
      internal_cost: item.internal_cost ?? null,
      position: idx,
      // recurring_schedule_id is intentionally NOT re-inserted here — it is
      // route-stamped only. Construction → null.
      schedule_frequency: item.schedule_frequency || null,
      schedule_interval_weeks: item.schedule_interval_weeks ?? 1,
      schedule_days_of_week: item.schedule_days_of_week ?? [],
      schedule_day_of_month: item.schedule_day_of_month ?? null,
      schedule_start_date: item.schedule_start_date || null,
      schedule_end_date: item.schedule_end_date || null,
    }));
    const { error: insertError } = await supabase
      .from("estimate_line_items")
      .insert(lineInserts);
    if (insertError) {
      toast.error(`Save failed: ${insertError.message}`);
      setPersisting(false);
      return;
    }
    setItems(all);
    toast.success("Line item added");
    setPersisting(false);
  }

  if (loading || !estimate) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const address = estimate.customers?.address ?? estimate.jobs?.address ?? null;
  const editable = estimate.status === "draft";
  const pricing = {
    markupPct: estimate.markup_pct,
    contingencyPct: estimate.contingency_pct,
    taxPct: estimate.tax_pct,
    depositPct: estimate.deposit_pct,
    depositAmount: estimate.deposit_amount,
  };
  const totals = computeEstimateTotals(items, pricing);

  const stripLines = (
    <ul className="divide-y divide-gray-100">
      {items.map((item) => (
        <li key={item.id} className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-gray-700">
            {item.description || "Untitled line"}
            <span className="ml-1 text-gray-400">
              · {item.quantity} {item.unit ?? ""} @ {formatMoney(item.unit_price)}
            </span>
          </span>
          <span className="flex-shrink-0 text-xs font-semibold text-gray-900">
            {formatMoney(item.quantity * item.unit_price)}
          </span>
        </li>
      ))}
      {items.length === 0 && (
        <li className="py-1.5 text-xs text-gray-400">
          No line items yet — price an area on the map.
        </li>
      )}
    </ul>
  );

  const totalsRows = (
    <div className="space-y-0.5 border-t border-gray-200 pt-1.5 text-xs">
      <div className="flex justify-between text-gray-600">
        <span>Subtotal</span>
        <span>{formatMoney(computeTotal(items))}</span>
      </div>
      {totals.markupAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Markup ({Number(estimate.markup_pct) || 0}%)</span>
          <span>{formatMoney(totals.markupAmount)}</span>
        </div>
      )}
      {totals.contingencyAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Contingency ({Number(estimate.contingency_pct) || 0}%)</span>
          <span>{formatMoney(totals.contingencyAmount)}</span>
        </div>
      )}
      {totals.taxAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Tax ({Number(estimate.tax_pct) || 0}%)</span>
          <span>{formatMoney(totals.taxAmount)}</span>
        </div>
      )}
      <div className="flex justify-between text-sm font-bold text-gray-900">
        <span>Total</span>
        <span>{formatMoney(totals.grandTotal)}</span>
      </div>
      {totals.depositAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Deposit</span>
          <span>{formatMoney(totals.depositAmount)}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2.5">
        <Link
          href={`/estimates/${estimate.id}`}
          className="flex items-center gap-1 px-2 py-1 text-sm text-blue-600 -ml-2"
        >
          <ArrowLeft className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">Estimate</span>
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-bold text-gray-900">
          {estimate.title || "Estimate"}
        </h1>
        <span className="flex-shrink-0">
          <StatusBadge
            tone={ESTIMATE_STATUS_TONE[estimate.status as EstimateStatus] ?? "neutral"}
            size="sm"
          >
            {ESTIMATE_STATUS_LABEL[estimate.status as EstimateStatus] ?? estimate.status}
          </StatusBadge>
        </span>
      </header>

      {/* Tab bar — able to take more tabs later (Landscape and Legend are
          roadmap, not this lane: they need point/line geometry that
          estimate_areas doesn't model yet, so no empty tabs shipped). */}
      <div className="sticky top-[49px] z-30 border-b border-gray-200 bg-white">
        <div className="mx-auto flex lg:max-w-3xl">
          {(
            [
              ["measure", "Measure"],
              ["items", "Items"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-2.5 text-sm font-semibold ${
                tab === key
                  ? "border-b-2 border-blue-700 text-blue-700"
                  : "text-gray-500"
              }`}
            >
              {label}
              {key === "items" && items.length > 0 && (
                <span className="ml-1 text-xs font-normal text-gray-400">
                  ({items.length})
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1">
        {tab === "measure" ? (
          // The map takes the screen: full width, no max-w column — its
          // internal sidebar (lg:w-96) and map panel need the room the shared
          // estimate page could never give it. On a phone it stays usable:
          // the map's own sidebar stacks above the map and the fullscreen
          // toggle takes over the whole screen while drawing.
          <div className="w-full p-3 lg:p-4">
            <LawnMeasurementMap
              estimateId={estimate.id}
              address={address}
              onAddLineItem={addMeasuredLine}
            />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-4">
            <div className="rounded-lg bg-white shadow-sm">
              <div className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">
                Line items
              </div>
              <div className="px-4 py-2">{stripLines}</div>
              <div className="px-4 pb-4">{totalsRows}</div>
            </div>
            {!editable && (
              <p className="rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-800">
                Only draft estimates accept edits. Pricing areas on the map will
                not be saved to this estimate — use Revise on the estimate
                document first.
              </p>
            )}
            {/* Hand the document side back — customer, terms, sending, the
                PDF and the email preview all live on the shared page. */}
            <Link
              href={`/estimates/${estimate.id}`}
              className="flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-sm font-semibold text-blue-700 shadow-sm hover:bg-gray-50"
            >
              <FileText className="h-4 w-4" />
              Open the estimate document
            </Link>
          </div>
        )}
      </main>

      {/* Running strip — visible while measuring so the number moves as areas
          are priced. Collapsed to one line on a phone (the map keeps the
          screen); expands to the full strip on demand. */}
      {tab === "measure" && (
        <div className="sticky bottom-0 z-30 border-t border-gray-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          {stripOpen && <div className="max-h-64 overflow-y-auto px-4 pt-2">{stripLines}</div>}
          {stripOpen && <div className="px-4 pb-2">{totalsRows}</div>}
          <button
            type="button"
            onClick={() => setStripOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left"
          >
            <span className="text-sm font-semibold text-gray-900">
              {items.length} {items.length === 1 ? "item" : "items"}
              <span className="ml-2 font-bold text-green-700">
                {formatMoney(totals.grandTotal)}
              </span>
            </span>
            {persisting ? (
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            ) : stripOpen ? (
              <ChevronDown className="h-4 w-4 text-gray-500" />
            ) : (
              <ChevronUp className="h-4 w-4 text-gray-500" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}