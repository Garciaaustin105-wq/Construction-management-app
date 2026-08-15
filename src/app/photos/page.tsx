import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import PhotoLightbox from "@/components/PhotoLightbox";
import PhotoFilters from "@/components/PhotoFilters";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";

// Office-only browse page: all photos across jobs, filterable by job + uploader.
export default async function PhotosPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; uploader?: string; page?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if ((profile?.role ?? "crew") !== "office") redirect("/dashboard");

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";
  const uploaderFilter = sp.uploader ?? "";

  // Fetch the most recent photos (capped) + the job list for the filter
  // dropdown. Office RLS sees all photos; the profiles join resolves uploader
  // names because office can read all profiles.
  const [photosRes, jobsRes] = await Promise.all([
    supabase
      .from("photos")
      .select(
        "id, storage_path, caption, created_at, uploaded_by, lat, lng, uploader:profiles(full_name), job:jobs(name)"
      )
      // Exclude lawn visit photos — those live in the Lawn tab. visit_id is set
      // only on photos attached to a lawn_visit; construction photos are null.
      .is("visit_id", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("jobs").select("id, name").eq("type", "construction").order("name"),
  ]);

  type Row = {
    id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
    uploaded_by: string;
    lat: number | null;
    lng: number | null;
    uploader: { full_name: string | null } | null;
    job: { name: string | null } | null;
  };
  const all = (photosRes.data ?? []) as unknown as Row[];

  // Distinct uploaders (only people who actually uploaded) for the filter.
  const uploaderMap = new Map<string, string>();
  for (const p of all) {
    if (p.uploaded_by && !uploaderMap.has(p.uploaded_by)) {
      uploaderMap.set(
        p.uploaded_by,
        p.uploader?.full_name ?? "Unknown"
      );
    }
  }
  const uploaders = Array.from(uploaderMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Apply filters in memory.
  const filtered = all.filter((p) => {
    if (jobFilter && p.job?.name === null) return false;
    if (uploaderFilter && p.uploaded_by !== uploaderFilter) return false;
    return true;
  });
  // Job filter is by job id — but we only fetched job name. Resolve via jobsRes.
  const jobs = (jobsRes.data ?? []) as { id: string; name: string }[];
  let filteredById = filtered;
  if (jobFilter) {
    const jobName = jobs.find((j) => j.id === jobFilter)?.name ?? null;
    filteredById = filtered.filter((p) => (p.job?.name ?? null) === jobName);
  }

  // Paginate the filtered set: render 24 transformed thumbnails per page so the
  // initial load mints/downloads only a handful of small images instead of the
  // whole 200-photo set. The uploader dropdown stays correct because it's built
  // from the full `all` fetch above, not the page slice.
  const PAGE_SIZE = 24;
  const page = Math.max(0, Number(sp.page ?? "0") || 0);
  const pageCount = Math.ceil(filteredById.length / PAGE_SIZE);
  const pageRows = filteredById.slice(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE
  );

  const photosForLightbox = pageRows.map((p) => ({
    id: p.id,
    storage_path: p.storage_path,
    caption: p.caption
      ? `${p.caption}${p.job?.name ? ` · ${p.job.name}` : ""}`
      : p.job?.name ?? null,
    created_at: p.created_at,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    uploaded_by_name: p.uploader?.full_name ?? null,
  }));

  // Build a pagination href that preserves the active job/uploader filters.
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (jobFilter) params.set("job", jobFilter);
    if (uploaderFilter) params.set("uploader", uploaderFilter);
    if (n > 0) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `/photos?${qs}` : "/photos";
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Photos" subtitle={`${filteredById.length} of ${all.length}`} />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <PhotoFilters
          jobs={jobs}
          uploaders={uploaders}
          currentJob={jobFilter}
          currentUploader={uploaderFilter}
        />

        <section>
          {photosForLightbox.length > 0 ? (
            <PhotoLightbox photos={photosForLightbox} canDelete />
          ) : (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Camera}
                title="No photos"
                description={
                  all.length === 0
                    ? "Field photos uploaded by your crew will show up here."
                    : "No photos match these filters."
                }
              />
            </div>
          )}
        </section>

        {pageCount > 1 && (
          <div className="flex items-center justify-between pt-1">
            {page > 0 ? (
              <Link
                href={pageHref(page - 1)}
                className="text-sm text-blue-600 font-medium"
              >
                ← Prev
              </Link>
            ) : (
              <span className="text-sm text-gray-300">← Prev</span>
            )}
            <span className="text-xs text-gray-500">
              Page {page + 1} of {pageCount}
            </span>
            {page < pageCount - 1 ? (
              <Link
                href={pageHref(page + 1)}
                className="text-sm text-blue-600 font-medium"
              >
                Next →
              </Link>
            ) : (
              <span className="text-sm text-gray-300">Next →</span>
            )}
          </div>
        )}
      </main>
    </div>
  );
}