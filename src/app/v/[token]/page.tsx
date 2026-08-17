import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { signedThumbnail, signedFull } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Public before/after photo portal for a lawn visit — no auth. The share_token
// in the URL (lawn_visits.share_token, an unguessable uuid minted per visit) is
// the only credential. Reached from the service_complete customer notification,
// which links to /v/{token}. Fetched via the service role (bypasses RLS) so a
// logged-out customer can view; the `job-photos` bucket is private, so signed
// URLs are minted server-side with the admin client (the storage signature in
// the signed URL grants access regardless of RLS, same as the receipts pattern).
//
// Photos today are undifferentiated (caption: null, no before/after split), so a
// single grid oldest→newest. An empty visit shows a friendly "not yet" state
// rather than a 404 — the service-complete email may land before the crew
// finishes uploading.

type Photo = { id: string; storage_path: string; caption: string | null };

export default async function PublicVisitPhotoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: visit } = await admin
    .from("lawn_visits")
    .select("id, job_id, organization_id, due_date, status")
    .eq("share_token", token)
    .maybeSingle();
  const v = visit as unknown as
    | {
        id: string;
        job_id: string;
        organization_id: string;
        due_date: string;
        status: string;
      }
    | null;
  if (!v) notFound();

  const { data: jobRow } = await admin
    .from("jobs")
    .select("name, address")
    .eq("id", v.job_id)
    .maybeSingle();
  const job = jobRow as unknown as
    | { name: string | null; address: string | null }
    | null;

  let orgName = "";
  let orgEmail: string | null = null;
  if (v.organization_id) {
    const { data: orgRow } = await admin
      .from("organizations")
      .select("name, email")
      .eq("id", v.organization_id)
      .maybeSingle();
    const o = orgRow as unknown as
      | { name: string | null; email: string | null }
      | null;
    if (o?.name) orgName = o.name;
    orgEmail = o?.email?.trim() || null;
  }

  // Oldest→newest so "before" precedes "after" in upload order.
  const { data: photoRows } = await admin
    .from("photos")
    .select("id, storage_path, caption")
    .eq("visit_id", v.id)
    .order("created_at", { ascending: true });
  const photos = (photoRows as unknown as Photo[] | null) ?? [];

  // Mint signed URLs server-side: a display thumbnail + a full-res link. Both
  // good for 1h (the page renders fresh on each open). Pair in a stable order.
  type Resolved = { id: string; thumb: string | null; full: string | null; caption: string | null };
  const resolved: Resolved[] = await Promise.all(
    photos.map(async (p) => {
      const [thumb, full] = await Promise.all([
        signedThumbnail(admin, "job-photos", p.storage_path, 1000, 80),
        signedFull(admin, "job-photos", p.storage_path, 3600),
      ]);
      return { id: p.id, thumb, full, caption: p.caption };
    })
  );

  const serviceDate = v.due_date
    ? new Date(`${v.due_date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#15803d" }}>
            <p className="text-white text-lg font-bold tracking-tight">{orgName}</p>
            <p className="text-green-100 text-xs uppercase tracking-wider mt-0.5">
              Service photos
            </p>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                {job?.name ?? "Your property"}
              </h1>
              {job?.address && (
                <p className="text-sm text-gray-500 mt-0.5">{job.address}</p>
              )}
              {serviceDate && (
                <p className="text-sm text-gray-600 mt-1">
                  Service completed {serviceDate}
                </p>
              )}
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">
              Here are the photos from your lawn service. Tap any photo to view
              it full size.
            </p>

            {resolved.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                {resolved.map((p) => {
                  const href = p.full ?? p.thumb ?? "#";
                  return (
                    <a
                      key={p.id}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="block aspect-square bg-gray-100 rounded-lg overflow-hidden"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.thumb ?? p.full ?? ""}
                        alt={p.caption ?? ""}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                    </a>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-10 px-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">
                  Photos will appear here once your crew finishes uploading them.
                  Check back shortly.
                </p>
              </div>
            )}
          </div>
        </div>

        {orgEmail && (
          <p className="text-center text-[11px] text-gray-400 mt-4">
            Questions? Contact {orgName} at {orgEmail}.
          </p>
        )}
      </div>
    </div>
  );
}