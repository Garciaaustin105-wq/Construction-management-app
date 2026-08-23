"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Download, Loader2, Plus, Search, ShieldAlert, X } from "lucide-react";
import {
  QUANTITY_UNITS,
  type ChemicalApplication,
  type ChemicalApplicationInput,
} from "@/lib/chemicals";

// The org's chemical application log — the compliance record an inspector asks
// for. Office/PM only (the shell gates it).
//
// INSERT-ONLY BY DESIGN. There is no edit or delete here: an application is an
// audit record, and a log you can quietly rewrite after the fact is worth
// nothing to a regulator. Corrections are a conversation with the office, not
// a button.
//
// LOGGING GOES THROUGH THE POST ROUTE, never a client-side insert, even though
// RLS would let office write directly. The route does three things this
// component must not duplicate: it snapshots the product's name / EPA # /
// active ingredient onto the row (so editing the catalog can't rewrite
// history), computes re_entry_until, and applies the crew gate. A direct insert
// would silently produce a row with no snapshot and no re-entry time — which
// looks fine in the list and is useless in an audit.

// Mirrors the shell's seed select exactly. Kept in sync by hand: a refetch that
// drops a column would blank fields the list renders.
const SELECT_COLUMNS =
  "id, organization_id, job_id, visit_id, product_id, product_name, epa_reg_number, active_ingredient, applicator_id, quantity_used, quantity_unit, rate, area_treated_sqft, target_pest, wind_mph, temp_f, applied_at, re_entry_hours, re_entry_until, notes, created_by, created_at, jobs(name, customers(name)), crew_members(name)";

type Option = { id: string; label: string };

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function fmtNum(n: number | null): string {
  return n == null ? "—" : String(n);
}

/**
 * Is the re-entry interval still running?
 *
 * Read at render time and intentionally not reactive — the chip reflects the
 * moment the list painted, which is what a compliance record needs. Lives at
 * module scope rather than as a `const now = Date.now()` in the component body
 * so the render stays pure (react-hooks/purity).
 */
function isRestricted(reEntryUntil: string | null): boolean {
  return reEntryUntil != null && Date.parse(reEntryUntil) > Date.now();
}

/** A datetime-local value for "now", in LOCAL time (not ISO/UTC). */
function nowLocalInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

export default function ChemicalApplicationsManager({
  initial,
}: {
  initial: ChemicalApplication[];
  // Part of the mount contract from the page shell, but unused here on purpose:
  // applications are never inserted client-side, and the POST route stamps the
  // org from the chosen job. Declared so the shell's props typecheck unchanged.
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [rows, setRows] = useState<ChemicalApplication[]>(initial);
  const [showLog, setShowLog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Filters — all client-side over `rows`; the list is small and org-scoped.
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applicator, setApplicator] = useState("");

  // Pickers for the log form. Loaded once when the drawer first opens rather
  // than on mount: most visits to this page are to read the log, not to write
  // to it, and four extra queries on every page load buys nothing.
  const [pickersLoaded, setPickersLoaded] = useState(false);
  const [jobs, setJobs] = useState<Option[]>([]);
  const [visits, setVisits] = useState<Option[]>([]);
  const [productOpts, setProductOpts] = useState<Option[]>([]);
  const [crew, setCrew] = useState<Option[]>([]);

  const [form, setForm] = useState({
    job_id: "",
    visit_id: "",
    product_id: "",
    manualProduct: false,
    product_name: "",
    epa_reg_number: "",
    active_ingredient: "",
    re_entry_hours: 0,
    applicator_id: "",
    quantity_used: 0,
    quantity_unit: QUANTITY_UNITS[0] as string,
    rate: 0,
    area_treated_sqft: 0,
    target_pest: "",
    wind_mph: 0,
    temp_f: 0,
    applied_at: nowLocalInput(),
    notes: "",
  });

  // Applicator filter options come from the rows themselves, so the dropdown
  // only ever offers people who actually appear in the log.
  const applicatorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const name = r.crew_members?.name;
      if (r.applicator_id && name) seen.set(r.applicator_id, name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, label: name }));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fromMs = from ? new Date(from).getTime() : null;
    // `to` is a date; include the whole day rather than cutting at midnight,
    // which would silently drop everything applied that afternoon.
    const toMs = to ? new Date(to).getTime() + 86_400_000 - 1 : null;

    return rows.filter((r) => {
      if (applicator && r.applicator_id !== applicator) return false;
      const t = Date.parse(r.applied_at);
      if (fromMs != null && t < fromMs) return false;
      if (toMs != null && t > toMs) return false;
      if (!q) return true;
      return [
        r.product_name,
        r.jobs?.name ?? "",
        r.jobs?.customers?.name ?? "",
        r.target_pest ?? "",
        r.epa_reg_number ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [rows, query, from, to, applicator]);

  // The export honours the same date window the user is looking at — an export
  // that silently ignored the filter would hand an inspector the wrong period.
  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return `/api/lawn/applications/export${qs ? `?${qs}` : ""}`;
  }, [from, to]);

  async function openLog() {
    setShowLog(true);
    setFormError(null);
    if (pickersLoaded) return;
    const [j, p, c] = await Promise.all([
      supabase.from("jobs").select("id, name").order("name"),
      supabase
        .from("chemical_products")
        .select("id, name")
        .eq("active", true)
        .order("name"),
      supabase.from("crew_members").select("id, name").order("name"),
    ]);
    setJobs(
      ((j.data as { id: string; name: string | null }[]) ?? []).map((x) => ({
        id: x.id,
        label: x.name ?? "Untitled job",
      }))
    );
    setProductOpts(
      ((p.data as { id: string; name: string }[]) ?? []).map((x) => ({
        id: x.id,
        label: x.name,
      }))
    );
    setCrew(
      ((c.data as { id: string; name: string | null }[]) ?? []).map((x) => ({
        id: x.id,
        label: x.name ?? "Unnamed",
      }))
    );
    setPickersLoaded(true);
  }

  // Visits depend on the chosen job, so they load per selection.
  useEffect(() => {
    // Whole body in an async IIFE so the setState lands in a later tick rather
    // than synchronously in the effect body (react-hooks/set-state-in-effect),
    // matching the mount-load pattern used across this codebase.
    (async () => {
      if (!form.job_id) {
        setVisits([]);
        return;
      }
      const { data } = await supabase
        .from("lawn_visits")
        .select("id, scheduled_date")
        .eq("job_id", form.job_id)
        .order("scheduled_date", { ascending: false });
      setVisits(
        ((data as { id: string; scheduled_date: string | null }[]) ?? []).map(
          (v) => ({
            id: v.id,
            label: v.scheduled_date
              ? new Date(v.scheduled_date).toLocaleDateString()
              : "Unscheduled",
          })
        )
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.job_id]);

  async function refetch() {
    const { data } = await supabase
      .from("chemical_applications")
      .select(SELECT_COLUMNS)
      .order("applied_at", { ascending: false });
    setRows((data as unknown as ChemicalApplication[]) ?? []);
  }

  async function submitLog(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.job_id) {
      setFormError("Job is required");
      return;
    }
    if (form.manualProduct && !form.product_name.trim()) {
      setFormError("Product name is required for a one-off product");
      return;
    }
    if (!form.manualProduct && !form.product_id) {
      setFormError("Choose a product, or switch to a one-off entry");
      return;
    }

    // product_id XOR product_name — the route rejects both together, and
    // sending both would make which one snapshots ambiguous.
    const input: ChemicalApplicationInput = {
      job_id: form.job_id,
      visit_id: form.visit_id || null,
      ...(form.manualProduct
        ? {
            product_name: form.product_name.trim(),
            epa_reg_number: form.epa_reg_number.trim() || undefined,
            active_ingredient: form.active_ingredient.trim() || undefined,
            re_entry_hours: form.re_entry_hours || null,
          }
        : { product_id: form.product_id }),
      applicator_id: form.applicator_id || null,
      quantity_used: form.quantity_used || null,
      quantity_unit: form.quantity_unit || null,
      rate: form.rate || null,
      area_treated_sqft: form.area_treated_sqft || null,
      target_pest: form.target_pest.trim() || undefined,
      wind_mph: form.wind_mph || null,
      temp_f: form.temp_f || null,
      // datetime-local is local time with no zone; converting through Date
      // gives the correct instant in ISO.
      applied_at: form.applied_at
        ? new Date(form.applied_at).toISOString()
        : undefined,
      notes: form.notes.trim() || undefined,
    };

    setSubmitting(true);
    let res: Response;
    try {
      res = await fetch("/api/lawn/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      setSubmitting(false);
      setFormError("Could not reach the server. Check your connection.");
      return;
    }
    const json = await res.json().catch(() => ({}) as { error?: string });
    setSubmitting(false);

    if (!res.ok) {
      // Verbatim — the route's messages are specific ("Visit does not belong to
      // this job") and far more useful than a generic failure.
      setFormError(json.error ?? "Could not log the application");
      return;
    }

    // The route returns only { ok, id }; refetch so the snapshotted fields and
    // computed re_entry_until are the server's values rather than a guess.
    await refetch();
    setShowLog(false);
    setForm((f) => ({
      ...f,
      visit_id: "",
      product_id: "",
      product_name: "",
      epa_reg_number: "",
      active_ingredient: "",
      quantity_used: 0,
      rate: 0,
      area_treated_sqft: 0,
      target_pest: "",
      wind_mph: 0,
      temp_f: 0,
      applied_at: nowLocalInput(),
      notes: "",
    }));
    toast.success("Application logged");
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-gray-600 flex-1 min-w-[120px]">
          {filtered.length}
          {filtered.length !== rows.length && ` of ${rows.length}`} application
          {filtered.length === 1 ? "" : "s"}
        </p>
        <a
          href={exportHref}
          className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </a>
        <button
          onClick={openLog}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white active:bg-emerald-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Log application
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg p-3 shadow-sm grid grid-cols-1 sm:grid-cols-4 gap-2">
        <label className="relative sm:col-span-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            className={`${field} pl-8`}
            placeholder="Search product, customer, job…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <input
          type="date"
          aria-label="From date"
          className={field}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="To date"
          className={field}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {applicatorOptions.length > 0 && (
          <select
            aria-label="Applicator"
            className={`${field} sm:col-span-2`}
            value={applicator}
            onChange={(e) => setApplicator(e.target.value)}
          >
            <option value="">All applicators</option>
            {applicatorOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          {rows.length === 0
            ? "No applications logged yet."
            : "No applications match these filters."}
        </p>
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="space-y-2 lg:hidden">
            {filtered.map((a) => {
              const restricted = isRestricted(a.re_entry_until);
              return (
                <li key={a.id} className="bg-white rounded-lg p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {a.product_name}
                    </p>
                    <span className="text-[11px] text-gray-400 shrink-0">
                      {fmtDateTime(a.applied_at)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {a.jobs?.customers?.name ?? "—"}
                    {a.jobs?.name ? ` · ${a.jobs.name}` : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                    {a.crew_members?.name && <span>{a.crew_members.name}</span>}
                    {a.epa_reg_number && <span>EPA {a.epa_reg_number}</span>}
                    {a.quantity_used != null && (
                      <span className="tabular-nums">
                        {a.quantity_used} {a.quantity_unit ?? ""}
                      </span>
                    )}
                  </div>
                  {restricted && (
                    <p className="mt-2 flex items-center gap-1.5 rounded bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] font-medium text-amber-900">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                      Stay off lawn until {fmtDateTime(a.re_entry_until)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Desktop table */}
          <div className="hidden lg:block bg-white rounded-lg shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr className="text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Applicator</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">EPA Reg #</th>
                  <th className="px-3 py-2 font-medium text-right">Qty</th>
                  <th className="px-3 py-2 font-medium text-right">Rate</th>
                  <th className="px-3 py-2 font-medium text-right">Area</th>
                  <th className="px-3 py-2 font-medium text-right">Wind</th>
                  <th className="px-3 py-2 font-medium text-right">Temp</th>
                  <th className="px-3 py-2 font-medium">Re-entry until</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((a) => {
                  const restricted = isRestricted(a.re_entry_until);
                  return (
                    <tr key={a.id}>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                        {fmtDateTime(a.applied_at)}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {a.crew_members?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-900">
                        {a.jobs?.customers?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {a.jobs?.name ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {a.product_name}
                      </td>
                      <td className="px-3 py-2 text-gray-600 tabular-nums">
                        {a.epa_reg_number ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums whitespace-nowrap">
                        {a.quantity_used != null
                          ? `${a.quantity_used} ${a.quantity_unit ?? ""}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                        {fmtNum(a.rate)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                        {fmtNum(a.area_treated_sqft)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                        {fmtNum(a.wind_mph)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                        {fmtNum(a.temp_f)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {restricted ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900">
                            <ShieldAlert className="h-3.5 w-3.5" />
                            {fmtDateTime(a.re_entry_until)}
                          </span>
                        ) : (
                          <span className="text-gray-400">
                            {fmtDateTime(a.re_entry_until)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Log drawer */}
      {showLog && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-black/40"
            onClick={() => setShowLog(false)}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Log application"
            className="w-full sm:w-[440px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                Log application
              </h2>
              <button
                onClick={() => setShowLog(false)}
                aria-label="Close"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <form onSubmit={submitLog} className="p-4 space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Job *</span>
                <select
                  className={`${field} mt-1`}
                  value={form.job_id}
                  onChange={(e) =>
                    setForm({ ...form, job_id: e.target.value, visit_id: "" })
                  }
                >
                  <option value="">Choose a job…</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.label}
                    </option>
                  ))}
                </select>
              </label>

              {form.job_id && visits.length > 0 && (
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Visit (optional)
                  </span>
                  <select
                    className={`${field} mt-1`}
                    value={form.visit_id}
                    onChange={(e) =>
                      setForm({ ...form, visit_id: e.target.value })
                    }
                  >
                    <option value="">Not tied to a visit</option>
                    {visits.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* Product: catalog or one-off */}
              <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.manualProduct}
                    onChange={(e) =>
                      setForm({ ...form, manualProduct: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Manual / one-off product
                </label>

                {form.manualProduct ? (
                  <>
                    <input
                      className={field}
                      placeholder="Product name *"
                      value={form.product_name}
                      onChange={(e) =>
                        setForm({ ...form, product_name: e.target.value })
                      }
                    />
                    <input
                      className={field}
                      placeholder="EPA registration number"
                      value={form.epa_reg_number}
                      onChange={(e) =>
                        setForm({ ...form, epa_reg_number: e.target.value })
                      }
                    />
                    <input
                      className={field}
                      placeholder="Active ingredient"
                      value={form.active_ingredient}
                      onChange={(e) =>
                        setForm({ ...form, active_ingredient: e.target.value })
                      }
                    />
                    <label className="block">
                      <span className="text-xs font-medium text-gray-600">
                        Re-entry hours
                      </span>
                      <NumberInput
                        value={form.re_entry_hours}
                        onChange={(n) =>
                          setForm({ ...form, re_entry_hours: n })
                        }
                        placeholder="0"
                        className={`${field} mt-1`}
                      />
                    </label>
                  </>
                ) : (
                  <select
                    aria-label="Product"
                    className={field}
                    value={form.product_id}
                    onChange={(e) =>
                      setForm({ ...form, product_id: e.target.value })
                    }
                  >
                    <option value="">Choose a product…</option>
                    {productOpts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Applicator
                </span>
                <select
                  className={`${field} mt-1`}
                  value={form.applicator_id}
                  onChange={(e) =>
                    setForm({ ...form, applicator_id: e.target.value })
                  }
                >
                  <option value="">Unassigned</option>
                  {crew.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Quantity used
                  </span>
                  <NumberInput
                    value={form.quantity_used}
                    onChange={(n) => setForm({ ...form, quantity_used: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Unit</span>
                  <select
                    className={`${field} mt-1`}
                    value={form.quantity_unit}
                    onChange={(e) =>
                      setForm({ ...form, quantity_unit: e.target.value })
                    }
                  >
                    {QUANTITY_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Rate</span>
                  <NumberInput
                    value={form.rate}
                    onChange={(n) => setForm({ ...form, rate: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Area (sqft)
                  </span>
                  <NumberInput
                    value={form.area_treated_sqft}
                    onChange={(n) =>
                      setForm({ ...form, area_treated_sqft: n })
                    }
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
              </div>

              <input
                className={field}
                placeholder="Target pest"
                value={form.target_pest}
                onChange={(e) =>
                  setForm({ ...form, target_pest: e.target.value })
                }
              />

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Wind (mph)
                  </span>
                  <NumberInput
                    value={form.wind_mph}
                    onChange={(n) => setForm({ ...form, wind_mph: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Temp (°F)
                  </span>
                  <NumberInput
                    value={form.temp_f}
                    onChange={(n) => setForm({ ...form, temp_f: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
              </div>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Applied at
                </span>
                <input
                  type="datetime-local"
                  className={`${field} mt-1`}
                  value={form.applied_at}
                  onChange={(e) =>
                    setForm({ ...form, applied_at: e.target.value })
                  }
                />
              </label>

              <textarea
                className={field}
                rows={3}
                placeholder="Notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />

              {formError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {formError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Log application
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
