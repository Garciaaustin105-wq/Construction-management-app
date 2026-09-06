import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import LaborFeedbackPanel from "@/components/LaborFeedbackPanel";
import { loadFeedbackData, loadCurrentRates } from "@/lib/crewFeedbackData";
import { jobVariance, calibration, buildSuggestions } from "@/lib/crewFeedback";

export const dynamic = "force-dynamic";

// Crew-time feedback: what the jobs actually took, against what they were
// quoted at, turned into proposed catalogue rates.
//
// WHY IT EXISTS: every published source on landscape estimating says the same
// thing — do not borrow production rates, time your own installs. The app has
// been collecting crew time all along and nothing read it back, so an org
// running a hundred jobs was sitting on better rates than any published table
// and could not see them. See docs/labor-production-rates.md.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the office policies on every
// catalogue the Apply button can write to (role-gate-mismatch pattern), and
// the API route checks the same thing again because a page gate does not
// protect a fetch.
//
// All reads go through src/lib/crewFeedbackData.ts and all maths through
// src/lib/crewFeedback.ts. No inline queries, nothing re-derived here.

export default async function LaborFeedbackPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const orgId = me.orgId ?? "";

  const [data, currentRates] = await Promise.all([
    loadFeedbackData(supabase, orgId),
    loadCurrentRates(supabase, orgId),
  ]);

  const variances = data.records.map(jobVariance);
  const summary = calibration(variances);
  const suggestions = buildSuggestions(data.records, currentRates);

  // Counted across every job, because the reason the sample is small is usually
  // the same one on all of them.
  const noCrewSizeTotal = variances.reduce((a, v) => a + v.time.noCrewSizeCount, 0);
  const openTotal = variances.reduce((a, v) => a + v.time.openCount, 0);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Labor feedback" />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">
            What your jobs actually took
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Your own crew times, read back against the rates that quoted them. Nothing
            here changes on its own — every figure is a proposal you can take or
            ignore, and your numbers beat any published table.
          </p>
        </header>

        {data.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {data.error}
          </div>
        ) : (
          <LaborFeedbackPanel
            calibration={summary}
            variances={variances}
            suggestions={suggestions}
            noCrewSizeTotal={noCrewSizeTotal}
            openTotal={openTotal}
            jobsWithoutEstimate={data.jobsWithoutEstimate}
          />
        )}
      </main>
    </div>
  );
}
