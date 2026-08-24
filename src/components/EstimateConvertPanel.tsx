"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { isLawn } from "@/lib/variant";
import {
  isSchedulable,
  summarizeLineSchedule,
  type ScheduleFrequency,
} from "@/lib/lawnEstimate";
import type { EstimateLine } from "@/components/EstimateLineItemEditor";

/**
 * Narrow an EstimateLine's cadence fields for the lawnEstimate helpers.
 *
 * EstimateLine types `schedule_frequency` as `string | null` (it round-trips a
 * DB text column through the save paths), while the helpers want the
 * `ScheduleFrequency` union. The cast is sound: CadencePicker is the only
 * writer of schedule_frequency, and it only ever emits a value from
 * SCHEDULE_FREQUENCIES (or null). There is deliberately NO DB CHECK constraint
 * on the column (the repo's no-frequency-whitelist convention — see
 * lawn_estimate_schedules.sql), so this adapter is the place the string→union
 * invariant is asserted; if a future writer sets a non-union value, the cast
 * would lie and summarizeLineSchedule could print an odd label. Done here, in
 * one adapter, rather than by widening the helper signatures or narrowing
 * EstimateLine — the latter would ripple into the save call sites this
 * component is not allowed to touch.
 */
function cadenceOf(line: EstimateLine) {
  return {
    schedule_frequency: line.schedule_frequency as ScheduleFrequency | null,
    schedule_interval_weeks: line.schedule_interval_weeks,
    schedule_days_of_week: line.schedule_days_of_week,
    schedule_day_of_month: line.schedule_day_of_month,
    schedule_start_date: line.schedule_start_date,
    schedule_end_date: line.schedule_end_date,
  };
}

// "Schedule approved services" — turns an APPROVED lawn estimate's schedulable
// line items into recurring schedules on a lawn job.
//
// The client never writes recurring_schedules or lawn_visits. This posts to
// /api/estimates/[id]/convert and renders what comes back; the route is the
// only writer, which is what keeps one job / N schedules consistent and stops a
// double-click from seeding two sets of visits.
//
// LAWN ONLY. isLawn() is a build-time constant, so on the construction deploy
// this component compiles to nothing rendered — the button can never appear on
// a construction estimate.

type ConvertedSchedule = {
  lineItemId: string;
  scheduleId: string;
  serviceType: string;
  visitCount: number;
};

type ConvertResponse = {
  jobId: string;
  created: boolean;
  schedules: ConvertedSchedule[];
};

export default function EstimateConvertPanel({
  estimateId,
  status,
  items,
  jobName,
}: {
  estimateId: string;
  status: string;
  items: EstimateLine[];
  /** Job the estimate is attached to, when known — used for the result line. */
  jobName?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResponse | null>(null);

  // Construction deploy: render nothing at all.
  if (!isLawn()) return null;

  // ── Already converted ────────────────────────────────────────────────────
  // Read from the loaded items rather than refetching: the convert route stamps
  // recurring_schedule_id onto each converted line, and the page already has
  // them. Shown for `converted` even without a fresh POST result, so a reload
  // still explains what happened.
  if (status === "converted" && !result) {
    const scheduled = items.filter((i) => i.recurring_schedule_id);
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          Converted — {scheduled.length} service
          {scheduled.length === 1 ? "" : "s"} scheduled
        </h3>
        {scheduled.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {scheduled.map((line, i) => (
              <li key={line.recurring_schedule_id ?? i} className="text-sm">
                <Link
                  href={`/lawn/schedules/${line.recurring_schedule_id}`}
                  className="inline-flex items-center gap-1 font-medium text-emerald-900 underline"
                >
                  {line.description || "Service"}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <span className="ml-2 text-xs text-emerald-800">
                  {summarizeLineSchedule(cadenceOf(line))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-emerald-800">
            This estimate has been converted.
          </p>
        )}
        <p className="mt-2 text-xs text-emerald-700">
          Edit visits and cadence on the schedule itself — the estimate is
          locked now.
        </p>
      </section>
    );
  }

  // ── Post-conversion result (this session) ────────────────────────────────
  if (result) {
    const first = result.schedules[0];
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          Scheduled {result.schedules.length} service
          {result.schedules.length === 1 ? "" : "s"}
        </h3>
        <p className="mt-1 text-sm text-emerald-800">
          Job: {jobName ?? "Lawn job"}{" "}
          <span className="text-xs">
            ({result.created ? "created" : "linked"})
          </span>
        </p>
        <ul className="mt-2 space-y-1.5">
          {result.schedules.map((s) => (
            <li key={s.scheduleId} className="text-sm">
              <Link
                href={`/lawn/schedules/${s.scheduleId}`}
                className="inline-flex items-center gap-1 font-medium text-emerald-900 underline"
              >
                {s.serviceType}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <span className="ml-2 text-xs text-emerald-800">
                {s.visitCount} visit{s.visitCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
        <button
          onClick={() => {
            if (first) router.push(`/lawn/schedules/${first.scheduleId}`);
            else router.refresh();
          }}
          className="mt-3 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white active:bg-emerald-700"
        >
          Done
        </button>
      </section>
    );
  }

  // ── The button ───────────────────────────────────────────────────────────
  const schedulable = items.filter((l) => isSchedulable(cadenceOf(l)));
  if (status !== "approved" || schedulable.length === 0) return null;

  async function convert() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/convert`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as Partial<
        ConvertResponse & { error: string }
      >;
      if (!res.ok) {
        // Verbatim — the route distinguishes already-converted (409),
        // not-approved (409), no schedulable lines (400), non-lawn (403),
        // missing (404), and partial failure (500). Flattening those into one
        // generic message would hide the only clue about which it was.
        setError(json.error ?? `Conversion failed (${res.status})`);
        return;
      }
      setResult(json as ConvertResponse);
      // Pull the estimate's new `converted` status into the page.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-green-200 bg-green-50 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-green-900">
        <CalendarCheck className="h-4 w-4" />
        Schedule approved services
      </h3>
      <p className="mt-1 text-sm text-green-800">
        Creates a recurring schedule for each service below and seeds its
        visits.
      </p>

      <ul className="mt-2 space-y-1">
        {schedulable.map((line, i) => (
          <li key={i} className="text-xs text-green-900">
            <span className="font-medium">
              {line.description || "Service"}
            </span>
            <span className="ml-2 text-green-800">
              {summarizeLineSchedule(cadenceOf(line))}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <button
        onClick={convert}
        disabled={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-green-700 px-3 py-2.5 text-sm font-semibold text-white active:bg-green-800 disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Schedule {schedulable.length} service
        {schedulable.length === 1 ? "" : "s"}
      </button>
    </section>
  );
}