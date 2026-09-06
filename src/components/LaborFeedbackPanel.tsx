"use client";

import { useState } from "react";
import { Check, Loader2, TriangleAlert, Info, Clock } from "lucide-react";
import type { Calibration, JobVariance, RateSuggestion } from "@/lib/crewFeedback";
import { MIN_SAMPLE } from "@/lib/crewFeedback";

// Reads crew time back against what was estimated and proposes rate changes.
//
// NOTHING ON THIS SCREEN APPLIES ITSELF. Every proposal shows its sample size
// and its spread, and Apply writes one row. That is the same rule the
// catalogues follow: the numbers belong to the org.
//
// It also does not grade anyone. A job that ran long looks identical here
// whether it rained, the access was bad, or the soil was rock — so the copy
// reports the measurement and stops.

type Props = {
  calibration: Calibration;
  variances: JobVariance[];
  suggestions: RateSuggestion[];
  noCrewSizeTotal: number;
  openTotal: number;
  jobsWithoutEstimate: number;
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
      {hint ? <div className="mt-1 text-xs text-gray-500">{hint}</div> : null}
    </div>
  );
}

export default function LaborFeedbackPanel({
  calibration,
  variances,
  suggestions,
  noCrewSizeTotal,
  openTotal,
  jobsWithoutEstimate,
}: Props) {
  const [applied, setApplied] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply(s: RateSuggestion) {
    if (s.suggested === null || busy) return;
    setBusy(s.key);
    setError(null);
    try {
      const res = await fetch("/api/labor-feedback/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: s.key, rate: s.suggested }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "That did not save.");
        return;
      }
      setApplied((prev) => ({ ...prev, [s.key]: s.suggested as number }));
    } catch {
      setError("That did not save.");
    } finally {
      setBusy(null);
    }
  }

  const actionable = suggestions.filter((s) => s.suggested !== null);
  const waiting = suggestions.filter((s) => s.suggested === null);
  const usableJobs = variances.filter((v) => v.usable);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Jobs compared"
          value={String(calibration.sampleSize)}
          hint={calibration.enough ? undefined : `${MIN_SAMPLE} is the minimum worth reading`}
        />
        <Stat
          label="Estimate vs actual"
          value={calibration.sampleSize > 0 ? `${calibration.medianRatio}x` : "—"}
          hint={
            calibration.sampleSize > 0
              ? `range ${calibration.lowRatio}x to ${calibration.highRatio}x`
              : undefined
          }
        />
        <Stat label="Rates proposed" value={String(actionable.length)} />
      </div>

      <p className="text-sm text-gray-700">{calibration.message}</p>

      {/* The fixable gap, stated plainly. Man-hours are duration times heads, so
          an entry with no crew size cannot be used at all — and this is usually
          the reason the sample is small. */}
      {noCrewSizeTotal > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>{noCrewSizeTotal}</strong> time{" "}
            {noCrewSizeTotal === 1 ? "entry has" : "entries have"} no crew size, so{" "}
            {noCrewSizeTotal === 1 ? "it was" : "they were"} left out. Man-hours are
            hours multiplied by the number of people on site — a three-person crew for
            eight hours is 24 man-hours, not 8 — so an entry without it cannot be
            counted at all. The crew lead confirms head count at shift start under
            Crews, and that is what makes this screen work.
          </span>
        </div>
      ) : null}

      {openTotal > 0 || jobsWithoutEstimate > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {openTotal > 0 ? (
              <>
                {openTotal} entr{openTotal === 1 ? "y is" : "ies are"} still running.{" "}
              </>
            ) : null}
            {jobsWithoutEstimate > 0 ? (
              <>
                {jobsWithoutEstimate} job{jobsWithoutEstimate === 1 ? " has" : "s have"}{" "}
                crew time but no estimate attached, so there is nothing to compare
                against.
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      {suggestions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-900">Nothing to read back yet.</p>
          <p className="mt-2 text-sm text-gray-600">
            This fills in as jobs finish. It needs a job with an estimate attached and
            clocked time that records the crew size. Jobs with a single task teach the
            most, because all of their hours belong to that one task.
          </p>
        </div>
      ) : null}

      {actionable.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-900">
            Proposed from your own jobs
          </h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Now</th>
                  <th className="px-4 py-2 font-medium">Your jobs say</th>
                  <th className="px-4 py-2 font-medium">Based on</th>
                  <th className="px-4 py-2 font-medium sr-only">Apply</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {actionable.map((s) => {
                  const done = applied[s.key];
                  return (
                    <tr key={s.key} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{s.label}</div>
                        <div className="text-xs text-gray-500">
                          man-min per {s.unit}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {s.currentRate > 0 ? (
                          s.currentRate
                        ) : (
                          // A blank rate is not a rate of zero, and the screen
                          // must not let it read as one.
                          <span className="text-amber-700">not set</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-900">
                        {s.medianRate}
                        <div className="text-xs font-normal text-gray-500">
                          {s.lowRate} to {s.highRate}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{s.message}</td>
                      <td className="px-4 py-3 text-right">
                        {done !== undefined ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
                            <Check className="h-3.5 w-3.5" /> set to {done}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => apply(s)}
                            disabled={busy !== null}
                            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                          >
                            {busy === s.key ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Use {s.medianRate}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Applying changes the catalogue from here on. Quotes already sent keep the
            figures they were built with.
          </p>
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-900">Not enough to say yet</h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {waiting.map((s) => (
                  <tr key={s.key}>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{s.label}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{s.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {usableJobs.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-900">Job by job</h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Estimated</th>
                  <th className="px-4 py-2 font-medium">Actual</th>
                  <th className="px-4 py-2 font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {usableJobs.map((v) => (
                  <tr key={v.jobId}>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{v.jobName}</td>
                    <td className="px-4 py-2.5 text-gray-700">{v.estimatedManHours} h</td>
                    <td className="px-4 py-2.5 text-gray-700">{v.actualManHours} h</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          v.deltaPct > 10
                            ? "text-amber-700"
                            : v.deltaPct < -10
                              ? "text-blue-700"
                              : "text-gray-600"
                        }
                      >
                        {v.deltaPct > 0 ? "+" : ""}
                        {v.deltaPct}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            A difference is a measurement, not a verdict. Weather, access, soil and a
            broken machine all look the same from here.
          </p>
        </section>
      ) : null}
    </div>
  );
}
