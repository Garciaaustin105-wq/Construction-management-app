"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Sprout } from "lucide-react";
import { useToast } from "@/components/Toast";
import { createClient } from "@/lib/supabase/client";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { generateDueDates } from "@/lib/lawnRecurrence";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Maps the frequency select to the canonical interval_weeks the generator uses.
const INTERVAL_BY_FREQUENCY: Record<string, number> = {
  weekly: 1,
  biweekly: 2,
  monthly: 4,
};

export default function NewProjectPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [crew, setCrew] = useState<{ id: string; full_name: string | null; email: string }[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [orgId, setOrgId] = useState<string>("");
  const toast = useToast();

  // ── Recurring lawn service ────────────────────────────────────────────────
  // When the toggle is on, the job gets a recurring_schedules row + a batch of
  // lawn_visits seeded for the upcoming season window. Off = a normal one-off
  // construction job (no schedule, no visits).
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState<"weekly" | "biweekly" | "monthly">("weekly");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [seasonStart, setSeasonStart] = useState("");
  const [seasonEnd, setSeasonEnd] = useState("");
  const [lawnServices, setLawnServices] = useState<
    { id: string; name: string; default_price: number }[]
  >([]);
  // service selection: a catalog service id, "custom" (free text), or "".
  const [servicePick, setServicePick] = useState("");
  const [customService, setCustomService] = useState("");
  const [pricePerVisit, setPricePerVisit] = useState("0");

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles").select("role, organization_id").eq("id", user.id).single();
      const role = profile?.role ?? "crew";
      // office + admin create jobs in their own org; super_admin (no org) uses
      // the platform view instead.
      if (isSuperAdmin(role) || !isOfficeLike(role) || !profile?.organization_id) {
        router.push("/dashboard");
        return;
      }
      setOrgId(profile.organization_id as string);
      const [{ data: custs }, { data: crews }, { data: services }] = await Promise.all([
        supabase.from("customers").select("id, name").order("name"),
        supabase.from("profiles").select("id, full_name, email").in("role", ["crew", "superintendent"]).order("full_name"),
        // Service catalog for the recurring-service dropdown (active, org-scoped via RLS).
        supabase.from("lawn_services").select("id, name, default_price").eq("active", true).order("name"),
      ]);
      setCustomers(custs ?? []);
      setCrew(crews ?? []);
      setLawnServices((services as { id: string; name: string; default_price: number }[]) ?? []);
    })();
  }, [router]);

  function toggleDay(d: number) {
    setDaysOfWeek((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  // When a catalog service is chosen, auto-fill the price from its default
  // (still editable). "custom" reveals a free-text service name.
  function onServicePick(value: string) {
    setServicePick(value);
    if (value === "custom") {
      setCustomService("");
      return;
    }
    const svc = lawnServices.find((s) => s.id === value);
    if (svc) {
      setCustomService(svc.name);
      setPricePerVisit(String(svc.default_price ?? 0));
    }
  }

  // The service_type label to store: the catalog name, the custom text, or
  // null if neither was provided.
  function resolvedServiceType(): string | null {
    return customService.trim() || null;
  }

  // Validate the recurring block; returns an error string or null.
  function validateRecurring(): string | null {
    if (!seasonStart) return "Pick a season start date";
    if (frequency !== "monthly" && daysOfWeek.length === 0)
      return "Pick at least one weekday";
    if (frequency === "monthly") {
      const dom = parseInt(dayOfMonth, 10);
      if (!dom || dom < 1 || dom > 28) return "Day of month must be 1–28";
    }
    if (!resolvedServiceType()) return "Pick or type a service";
    const price = parseFloat(pricePerVisit);
    if (isNaN(price) || price < 0) return "Price per visit must be 0 or more";
    return null;
  }

  // Build the schedule + seed visits for a freshly created lawn job. Runs after
  // the jobs insert succeeds. Generates visits for the upcoming window only
  // (max(start, today) → min(end, today+90d)) so a job created mid-season
  // doesn't back-fill dozens of "pending" rows; the schedule detail page can
  // regenerate/extend later. All inserts use RLS (browser client).
  async function createRecurring(jobId: string, userId: string) {
    const supabase = createClient();
    const intervalWeeks = INTERVAL_BY_FREQUENCY[frequency] ?? 1;
    const scheduleRow = {
      job_id: jobId,
      // organization_id is NOT sent — trg_recurring_schedules_org stamps it
      // from job_id via set_org_from_job (same as every job-child table).
      frequency,
      interval_weeks: intervalWeeks,
      days_of_week: frequency === "monthly" ? [] : daysOfWeek,
      day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
      start_date: seasonStart,
      end_date: seasonEnd || null,
      service_type: resolvedServiceType(),
      price_per_visit: parseFloat(pricePerVisit) || 0,
      active: true,
      created_by: userId,
    };
    const { data: sched, error: schedErr } = await supabase
      .from("recurring_schedules")
      .insert(scheduleRow)
      .select("id")
      .single();
    if (schedErr || !sched) {
      throw new Error(`Schedule failed: ${schedErr?.message ?? "error"}`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const genFrom = seasonStart > today ? seasonStart : today;
    // Generate through the earlier of season end and today+90d.
    const todayPlus90 = new Date();
    todayPlus90.setUTCDate(todayPlus90.getUTCDate() + 90);
    let genTo = todayPlus90.toISOString().slice(0, 10);
    if (seasonEnd && seasonEnd < genTo) genTo = seasonEnd;
    const dueDates = generateDueDates(
      {
        frequency,
        interval_weeks: intervalWeeks,
        days_of_week: frequency === "monthly" ? [] : daysOfWeek,
        day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
        start_date: seasonStart,
        end_date: seasonEnd || null,
      },
      genFrom,
      genTo
    );
    if (dueDates.length === 0) return 0;

    const visits = dueDates.map((due_date) => ({
      recurring_schedule_id: sched.id,
      job_id: jobId, // set_org_from_job stamps org from this
      due_date,
      status: "pending" as const,
    }));
    // Ignore 23505 (a date already exists from a prior run) — unique
    // (recurring_schedule_id, due_date) keeps visits deduped.
    const { error: visitErr } = await supabase.from("lawn_visits").insert(visits);
    if (visitErr && visitErr.code !== "23505") {
      throw new Error(`Visits failed: ${visitErr.message}`);
    }
    return dueDates.length;
  }

  function toggleCrew(id: string) {
    setAssigned((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (recurring) {
      const vErr = validateRecurring();
      if (vErr) {
        toast.warning(vErr);
        return;
      }
    }
    setLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("jobs").insert({
      customer_id: customerId || null,
      name,
      address: address || null,
      description: description || null,
      status: "scheduled",
      scheduled_start: scheduledStart || null,
      scheduled_end: scheduledEnd || null,
      assigned_crew: assigned,
      organization_id: orgId,
    }).select().single();
    if (error) {
      toast.error(`Failed to create: ${error.message}`);
      setLoading(false);
      return;
    }

    // If recurring, attach the schedule + seed the upcoming visits. A failure
    // here does NOT roll back the job — the job exists and is usable; we just
    // surface the error so the office can retry from the schedule detail page.
    let visitCount = 0;
    if (recurring) {
      try {
        visitCount = await createRecurring(data.id, user.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        toast.error(`Job created, but recurring setup failed: ${msg}`);
        setTimeout(() => router.push(`/jobs/${data.id}`), 1200);
        return;
      }
    }

    toast.success(
      recurring
        ? `Project created${visitCount > 0 ? ` · ${visitCount} upcoming visits seeded` : ""}`
        : "Project created"
    );
    setTimeout(() => router.push(`/jobs/${data.id}`), 600);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          New Project
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Project Name *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="Office Building Cat6 Install"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Address</span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="123 Main St, City"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Description / Scope</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              placeholder="40 Cat6 drops, terminate and test..."
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Start</span>
              <input
                type="date"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">End</span>
              <input
                type="date"
                value={scheduledEnd}
                onChange={(e) => setScheduledEnd(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
          </div>

          {crew.length > 0 && (
            <div>
              <span className="text-sm font-medium text-gray-700">Assign Crew</span>
              <div className="mt-2 space-y-2">
                {crew.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 active:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={assigned.includes(c.id)}
                      onChange={() => toggleCrew(c.id)}
                      className="w-5 h-5"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {c.full_name ?? c.email}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{c.email}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Recurring lawn service toggle. When on, this job gets a
              recurring_schedules row + seeded lawn_visits (the Lawn tab lists
              jobs that have a schedule). Off = a normal one-off job. */}
          <div className="border-t border-gray-200 pt-4 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(e) => setRecurring(e.target.checked)}
                className="w-5 h-5"
              />
              <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                <Sprout className="w-4 h-4 text-green-600" />
                Recurring lawn service
              </span>
            </label>

            {recurring && (
              <div className="space-y-3 bg-green-50/50 rounded-lg p-3">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Frequency *</span>
                  <select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as "weekly" | "biweekly" | "monthly")}
                    className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Biweekly (every 2 weeks)</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>

                {frequency === "monthly" ? (
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700">Day of month (1–28) *</span>
                    <input
                      type="number"
                      min={1}
                      max={28}
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(e.target.value)}
                      className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                      placeholder="15"
                    />
                  </label>
                ) : (
                  <div>
                    <span className="text-sm font-medium text-gray-700">Weekdays *</span>
                    <div className="mt-2 grid grid-cols-7 gap-1">
                      {WEEKDAYS.map((label, d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDay(d)}
                          className={`py-2 rounded-md text-xs font-semibold ${
                            daysOfWeek.includes(d)
                              ? "bg-green-600 text-white"
                              : "bg-white border border-gray-300 text-gray-600"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700">Season start *</span>
                    <input
                      type="date"
                      value={seasonStart}
                      onChange={(e) => setSeasonStart(e.target.value)}
                      className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700">Season end (opt.)</span>
                    <input
                      type="date"
                      value={seasonEnd}
                      onChange={(e) => setSeasonEnd(e.target.value)}
                      className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Service *</span>
                  <select
                    value={servicePick}
                    onChange={(e) => onServicePick(e.target.value)}
                    className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                  >
                    <option value="">Select service</option>
                    {lawnServices.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    <option value="custom">Other (type your own)</option>
                  </select>
                  {servicePick === "custom" && (
                    <input
                      type="text"
                      value={customService}
                      onChange={(e) => setCustomService(e.target.value)}
                      placeholder="e.g. Sprinkler winterization"
                      className="mt-2 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                    />
                  )}
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Price per visit *</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={pricePerVisit}
                    onChange={(e) => setPricePerVisit(e.target.value)}
                    className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                    placeholder="45.00"
                  />
                </label>

                <p className="text-xs text-gray-500">
                  Visits for the next ~90 days (within the season) are created automatically —
                  generate more from the schedule later.
                </p>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Creating..." : "Create Project"}
          </button>
        </form>
      </main>

    </div>
  );
}