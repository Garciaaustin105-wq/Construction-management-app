import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isLawn } from "@/lib/variant";
import { FIELD, MANAGEMENT } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import LawnPhotoGallery, { type GalleryPhoto } from "@/components/LawnPhotoGallery";
import { Camera } from "lucide-react";

// The lawn photo library.
//
// The "Photos" tab used to be an upload FORM — 458 lines titled "Upload
// Photos", with no gallery at all. Lawn before/after pairs were only visible on
// the individual visit page, so there was nowhere to browse a property's
// history, and nowhere to get an image back out. Orgs use these to advertise,
// so a photo you cannot download is a photo you cannot use.
//
// Open to FIELD as well as MANAGEMENT: crews take these photos and have a
// legitimate reason to check their own work uploaded correctly. RLS scopes
// every row to the caller's organisation regardless.

export const dynamic = "force-dynamic";

export default async function LawnPhotosPage({
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

  // The job list drives the filter. Scoped to lawn jobs by type, because the
  // construction org owns one lawn job and RLS alone would not keep the two
  // apps' pickers apart.
  const [photosRes, jobsRes] = await Promise.all([
    (() => {
      let q = supabase
        .from("photos")
        .select(
          "id, storage_path, caption, created_at, phase, visit_id, job:jobs!inner(name, type), visit:lawn_visits(due_date)"
        )
        // !inner on jobs is deliberate here, unlike the calendar: a photo with
        // no job cannot be grouped by property, which is the whole organising
        // principle of this page.
        .eq("job.type", "lawn")
        .order("created_at", { ascending: false })
        .limit(300);
      if (jobFilter) q = q.eq("job_id", jobFilter);
      return q;
    })(),
    supabase.from("jobs").select("id, name").eq("type", "lawn").order("name"),
  ]);

  type Row = {
    id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
    phase: "before" | "after" | null;
    visit_id: string | null;
    job: { name: string | null; type: string | null } | null;
    visit: { due_date: string | null } | null;
  };

  const rows = (photosRes.data ?? []) as unknown as Row[];
  const photos: GalleryPhoto[] = rows.map((r) => ({
    id: r.id,
    storage_path: r.storage_path,
    caption: r.caption,
    created_at: r.created_at,
    phase: r.phase,
    visit_id: r.visit_id,
    job_name: r.job?.name ?? "Untitled property",
    due_date: r.visit?.due_date ?? null,
  }));

  const jobs = (jobsRes.data ?? []) as { id: string; name: string }[];
  const tagged = photos.filter((p) => p.phase !== null).length;

  return (
    <PageContainer
      title="Photos"
      subtitle="Before and after, by property — download any shot to use"
      maxWidth="wide"
      mainClassName="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* A plain form rather than a client component: one control, and the
            server component already re-renders from the URL. */}
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
            <Link href="/lawn/photos" className="text-sm text-gray-600 hover:underline">
              Clear
            </Link>
          )}
        </form>

        <Link
          href="/crew/photo"
          className="ml-auto inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-gray-300 bg-white font-medium"
        >
          <Camera className="w-4 h-4" />
          Upload
        </Link>
      </div>

      {/* Stated plainly rather than hidden: a pair only exists if someone tagged
          the shots, and until crews do that this page is a flat archive. Saying
          so is more useful than silently showing everything as "other". */}
      {photos.length > 0 && tagged === 0 && (
        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          None of these are tagged before or after yet. Crews choose that when
          adding photos to a visit; untagged shots still appear here and can
          still be downloaded.
        </p>
      )}

      <LawnPhotoGallery photos={photos} />
    </PageContainer>
  );
}
