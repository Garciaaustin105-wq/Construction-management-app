"use client";

// "Will today actually work?" — the persistent, always-current half of the
// solo→crew problem (the other half, the one-shot crew_mode_started
// notification, fires once from the database and is not this).
//
// This component is deliberately dumb about policy: `assessReadiness` from
// @/lib/fieldReadiness decides mode, severities and ordering, and this renders
// them in the order given. The one rule restated here because it governs the
// markup shape: SOLO IS NOT A PROBLEM. A solo org with unassigned visits shows
// reassurance, never a call to action about them — the same facts read as
// blocking only once a crew member has a login.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Info,
  UserX,
} from "lucide-react";
import { assessReadiness, hasBlocking, type Readiness } from "@/lib/fieldReadiness";
import { isLawn } from "@/lib/variant";
import { createClient } from "@/lib/supabase/client";

type VisitRow = {
  id: string;
  crew_id: string | null;
  crew_team_id: string | null;
  // Pin + lot size live on lawn_jobs, reached THROUGH the job (same embed the
  // calendar and My Route already use — a direct lawn_jobs() on the visit has
  // no FK and would 400).
  jobs: { lawn_jobs: { map_lat: number | null; lot_sqft: number | null } | null } | null;
};

export default function FieldReadinessBanner() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  // Readiness issues carry gap counts only, not the total — the "N of M"
  // headline needs it alongside.
  const [visitsToday, setVisitsToday] = useState(0);

  useEffect(() => {
    if (!isLawn()) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // Same UTC day key the server page uses for its "Today" list, so the
      // banner can never describe a different day than the list below it.
      const today = new Date().toISOString().slice(0, 10);
      // One fetch on load — never a polling loop. RLS scopes both reads; no
      // manual organization_id filters.
      const [crewR, visitsR] = await Promise.all([
        // Members with no login are a name on a roster, not a field worker —
        // the same rule My Route and the geofence apply.
        supabase
          .from("crew_members")
          .select("id", { count: "exact", head: true })
          .not("user_id", "is", null),
        supabase
          .from("lawn_visits")
          .select(
            "id, crew_id, crew_team_id, jobs(lawn_jobs(map_lat, lot_sqft))"
          )
          .eq("status", "pending")
          .eq("due_date", today),
      ]);
      if (cancelled) return;
      const rows = (visitsR.data as unknown as VisitRow[] | null) ?? [];
      const input = {
        crewMembersWithLogin: crewR.count ?? 0,
        visitsToday: rows.length,
        unassignedToday: rows.filter(
          (r) => r.crew_id == null && r.crew_team_id == null
        ).length,
        withPinToday: rows.filter((r) => r.jobs?.lawn_jobs?.map_lat != null)
          .length,
        withSqftToday: rows.filter((r) => r.jobs?.lawn_jobs?.lot_sqft != null)
          .length,
      };
      setVisitsToday(rows.length);
      setReadiness(assessReadiness(input));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!readiness) return null;

  const { mode, issues } = readiness;
  const total = visitsToday;
  const blocking = hasBlocking(readiness);

  const headline =
    total === 0
      ? null
      : readiness.autoStampableToday === total
        ? `All ${total} visits today will record arrival automatically.`
        : `${readiness.autoStampableToday} of ${total} visits today will record arrival automatically.`;

  // Per-issue one-liners. The wording pairs are load-bearing: a gap here means
  // the property is unmeasured or unassigned by the office — never phrased as
  // the crew's doing, and a missing pin is reduced automation, not breakage.
  const ISSUE_LINE: Record<string, { body: (n: number) => string; sub?: string }> = {
    unassigned_visits: {
      body: (n) =>
        n === total
          ? `All ${total} visits today are on nobody's route.`
          : `${n} of ${total} visits today are on nobody's route.`,
    },
    missing_pins: {
      body: (n) =>
        n === 1
          ? "1 visit has no map pin."
          : `${n} visits have no map pin.`,
      sub:
        "They still work with the manual Start and Done buttons — arrival just isn't recorded for them automatically.",
    },
    missing_sqft: {
      body: (n) =>
        n === 1
          ? "1 visit has no lot size on file."
          : `${n} visits have no lot size on file.`,
      sub:
        "Time is still recorded; only the price-per-sqft figure can't be shown yet.",
    },
  };

  const iconClass =
    blocking
      ? "text-red-600 bg-red-100"
      : issues.some((i) => i.severity === "warning")
        ? "text-amber-600 bg-amber-100"
        : mode === "solo" && issues[0]?.code === "no_visits"
          ? "text-gray-400 bg-gray-100"
          : "text-green-600 bg-green-100";
  const Icon =
    blocking
      ? UserX
      : issues.some((i) => i.severity === "warning")
        ? AlertTriangle
        : issues[0]?.code === "no_visits"
          ? CalendarDays
          : CheckCircle2;

  return (
    <div
      role="status"
      className={`rounded-lg shadow-sm border p-4 ${
        blocking
          ? "bg-red-50 border-red-200"
          : issues.some((i) => i.severity === "warning")
            ? "bg-amber-50 border-amber-200"
            : "bg-white border-gray-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${iconClass}`}
        >
          <Icon className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold ${
              blocking
                ? "text-red-800"
                : issues.some((i) => i.severity === "warning")
                  ? "text-amber-800"
                  : "text-gray-700"
            }`}
          >
            {headline ?? "Nothing scheduled for today."}
          </p>

          {/* Issue lines, in the order assessReadiness returned. */}
          <div className="mt-1 space-y-1.5">
            {issues.map((issue) => {
              if (issue.code === "no_visits") return null;
              const line = ISSUE_LINE[issue.code];
              if (!line) return null;
              return (
                <div key={issue.code} className="text-sm text-gray-700">
                  <p className="flex items-start gap-1.5">
                    {issue.severity === "info" && (
                      <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" />
                    )}
                    <span>{line.body(issue.count)}</span>
                  </p>
                  {line.sub && (
                    <p className="text-xs text-gray-500 mt-0.5">{line.sub}</p>
                  )}
                  {issue.code === "unassigned_visits" && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Assign them on the{" "}
                      <Link
                        href="/lawn/calendar"
                        className="font-semibold text-red-700 underline"
                      >
                        route calendar
                      </Link>{" "}
                      — and set a default crew on the recurring schedule so new
                      weeks don&apos;t come up empty.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Solo reassurance: the unassigned-visits fact, stated as the
              system working — deliberately NOT a call to action. */}
          {mode === "solo" && total > 0 && !blocking && (
            <p className="text-xs text-gray-500 mt-1">
              You&apos;re running solo — visits without an assignment come to
              your route automatically.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}