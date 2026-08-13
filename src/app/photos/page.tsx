import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import PhotoLightbox from "@/components/PhotoLightbox";
import PhotoFilters from "@/components/PhotoFilters";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";

// Office-only browse page: all photos across jobs, filterable by job + uploader.
export default async function PhotosPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; uploader?: string }>;
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
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("jobs").select("id, name").order("name"),
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

  const photosForLightbox = filteredById.map((p) => ({
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Photos" subtitle={`${filteredById.length} of ${all.length}`} />
      <main className="max-w-md mx-auto p-4 space-y-4">
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
      </main>
    </div>
  );
}