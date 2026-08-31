import { redirect } from "next/navigation";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import { canTrackCrew } from "@/lib/planGate";
import { isLawn } from "@/lib/variant";
import CrewTrackMap from "@/components/CrewTrackMap";
import { RETENTION_DAYS } from "@/lib/crewTracking";
import { Lock } from "lucide-react";

// Live crew tracking (lawn). Office / PM / admin see where clocked-in crew are
// right now.
//
// GATE ORDER matters here. requireRole(OFFICE_OR_PM) matches the crew_locations
// read policy exactly (me_is_office_or_pm) so the page gate and the data gate
// cannot drift — the role-gate-mismatch pattern this codebase has been bitten
// by before. Then the variant gate (lawn only), then the plan gate.
//
// The plan gate renders an upgrade panel rather than redirecting: a free org
// that lands here should learn what the feature is and how to get it, not be
// bounced to a page that doesn't explain anything. It also means the map
// component never mounts for a free org, so no Realtime presence is registered
// and no crew client is ever woken — the gate is a real cost boundary, not just
// a UI one.
//
// NOTE there is no server-side data fetch at all. The live view is entirely
// Realtime broadcast, so this page ships no query and no polling; the only DB
// reads in the whole feature are the sparse breadcrumbs, and those are for
// history rather than the live map.

export const dynamic = "force-dynamic";

export default async function CrewTrackPage() {
  const me = await requireRole(OFFICE_OR_PM, "/lawn");
  if (!isLawn()) redirect("/dashboard");
  // super_admin has no org, so there is no channel to join and nothing to show.
  if (!me.orgId) redirect("/lawn");

  const allowed = canTrackCrew(me);

  return (
    <PageContainer title="Crew tracking" subtitle="Live locations" maxWidth="wide">
        {allowed ? (
          <CrewTrackMap orgId={me.orgId} viewerId={me.user.id} />
        ) : (
          <div className="bg-white rounded-lg shadow-sm p-6 max-w-xl">
            <div className="flex items-start gap-3">
              <Lock className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
              <div>
                <h2 className="font-semibold text-gray-900">
                  Crew tracking is on paid plans
                </h2>
                <p className="text-sm text-gray-600 mt-2">
                  See where your crew are while they&apos;re on the clock —
                  useful for answering &ldquo;how far out are they?&rdquo;
                  without calling, and for settling a &ldquo;nobody showed
                  up&rdquo; dispute.
                </p>
                <p className="text-sm text-gray-600 mt-2">
                  The Free plan is a single seat, so there&apos;s no crew to
                  track yet. Add crew on Starter or higher and this map turns on.
                </p>
                <Link
                  href="/admin/billing"
                  className="inline-block mt-4 bg-brand text-white rounded-lg px-4 py-2 text-sm font-semibold"
                >
                  See plans
                </Link>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 text-xs text-gray-500 max-w-2xl space-y-1">
          <p className="font-semibold text-gray-600">How this works</p>
          <p>
            Crew phones share location only while clocked in, and only while
            someone has this page open — closing it stops the sharing. Crew see
            an indicator on their own screen whenever it&apos;s active.
          </p>
          <p>
            A position is saved roughly every 5 minutes for {RETENTION_DAYS}{" "}
            days so you can answer questions about earlier in the week, then
            it&apos;s deleted automatically.
          </p>
          <p>
            Employee location tracking is regulated and the rules vary by state
            — several require written notice or consent. Tell your crew this is
            on before you switch it on.
          </p>
        </div>
    </PageContainer>
  );
}
