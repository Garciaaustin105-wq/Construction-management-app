import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isLawn } from "@/lib/variant";
import { FIELD, MANAGEMENT } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import CompletedVisitsList, {
  type CompletedVisit,
} from "@/components/CompletedVisitsList";

// Work that got done — the counterpart to /lawn/overdue.
//
// There was nowhere to answer "did we cut that yard, and when?". My Route shows
// today and what is late, the calendar shows the schedule, /lawn/jobs lists
// properties and their recurring schedules. A finished visit fell out of every
// one of them the moment it was marked done, taking its photos with it. So the
// evidence a customer might ask for existed and was unreachable.
//
// Deliberately visit-level, not job-level. A lawn "job" is a standing property
// that is never finished; what completes is a VISIT. Listing properties here
// would answer the wrong question.

export const dynamic = "force-dynamic";

export default async function LawnCompletedPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (!(FIELD.has(role as never) || MANAGEMENT.has(role as never))) {
    redirect("/dashboard");
  }

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";

  const supabase = await createClient();

  let visitQ = supabase
    .from("lawn_visits")
    .select(
      "id, job_id, due_date, completed_at, started_at, on_site_first_at, on_site_last_at, on_site_user_ids, jobs(name, address, customers(name))"
    )
    .eq("status", "done")
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (jobFilter) visitQ = visitQ.eq("job_id", jobFilter);

  const [visitsRes, jobsRes] = await Promise.all([
    visitQ,
    supabase.from("jobs").select("id, name").eq("type", "lawn").order("name"),
  ]);

  type VRow = {
    id: string;
    job_id: string;
    due_date: string;
    completed_at: string | null;
    started_at: string | null;
    on_site_first_at: string | null;
    on_site_last_at: string | null;
    on_site_user_ids: string[] | null;
    jobs: {
      name: string | null;
      address: string | null;
      customers: { name: string | null } | null;
    } | null;
  };
  const rows = (visitsRes.data ?? []) as unknown as VRow[];

  // Photos in ONE query keyed by visit, rather than a per-row lookup. With 200
  // visits the alternative is 200 round trips for a page that is mostly a list.
  const ids = rows.map((r) => r.id);
  const { data: photoRows } = ids.length
    ? await supabase
        .from("photos")
        .select("id, visit_id, storage_path, caption, created_at, phase")
        .in("visit_id", ids)
        .order("created_at", { ascending: true })
    : { data: [] };

  type PRow = {
    id: string;
    visit_id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
    phase: "before" | "after" | null;
  };
  const byVisit = new Map<string, PRow[]>();
  for (const p of (photoRows ?? []) as unknown as PRow[]) {
    const arr = byVisit.get(p.visit_id) ?? [];
    arr.push(p);
    byVisit.set(p.visit_id, arr);
  }

  const visits: CompletedVisit[] = rows.map((r) => {
    // Prefer the MEASURED window over start-to-done. The geofence records it
    // without anyone tapping anything, so it survives a crew that forgot the
    // buttons — and it is the number the pricing model uses.
    const measuredMs =
      r.on_site_first_at && r.on_site_last_at
        ? new Date(r.on_site_last_at).getTime() - new Date(r.on_site_first_at).getTime()
        : null;
    const tappedMs =
      r.started_at && r.completed_at
        ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
        : null;
    return {
      id: r.id,
      dueDate: r.due_date,
      completedAt: r.completed_at,
      jobName: r.jobs?.name ?? "Untitled property",
      address: r.jobs?.address ?? null,
      customerName: r.jobs?.customers?.name ?? null,
      minutes:
        measuredMs !== null
          ? Math.round(measuredMs / 60000)
          : tappedMs !== null
            ? Math.round(tappedMs / 60000)
            : null,
      minutesSource: measuredMs !== null ? "measured" : tappedMs !== null ? "tapped" : null,
      phones: r.on_site_user_ids?.length ?? 0,
      photos: (byVisit.get(r.id) ?? []).map((p) => ({
        id: p.id,
        storage_path: p.storage_path,
        caption: p.caption,
        created_at: p.created_at,
        phase: p.phase,
      })),
    };
  });

  const jobs = (jobsRes.data ?? []) as { id: string; name: string }[];
  const withPhotos = visits.filter((v) => v.photos.length > 0).length;

  return (
    <PageContainer
      title="Completed"
      subtitle="Finished visits, with the photos and time recorded against them"
      maxWidth="wide"
      mainClassName="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <form method="GET" className="flex items-center gap-2">
          <label htmlFor="job" className="text-xs font-medium text-gray-600">
            Property
          </label>
          <select
            id="job"
            name="job"
            defaultValue={jobFilter}
            className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
          >
            <option value="">All properties</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-900 text-white font-medium"
          >
            Filter
          </button>
          {jobFilter && (
            <Link href="/lawn/completed" className="text-sm text-gray-600 hover:underline">
              Clear
            </Link>
          )}
        </form>
        <p className="ml-auto text-xs text-gray-500">
          {visits.length} completed · {withPhotos} with photos
        </p>
      </div>

      <CompletedVisitsList visits={visits} />
    </PageContainer>
  );
}
