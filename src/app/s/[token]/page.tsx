import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import SubmittalReturnButtons from "./SubmittalReturnButtons";

export const dynamic = "force-dynamic";

// Public submittal review view — no auth. The share_token in the URL is the
// only credential. Fetched via the service role. Office hits Send → the
// reviewer (architect/owner) opens this link → views the submittal + attached
// files → returns a disposition at /api/submittals/by-token/[token]/return.
//
// File bytes live in the private `submittal-files` bucket (paths
// <jobId>/<submittalId>/<file>); signed URLs are minted server-side with the
// service role so the unauthenticated reviewer can open them. The first open
// stamps viewed_at (fire-and-forget).
export default async function PublicSubmittalPage({
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

  const { data: submittal } = await admin
    .from("submittals")
    .select(
      "id, title, description, csi_section, submittal_number, status, disposition, sent_at, returned_at, organization_id, jobs(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!submittal) {
    notFound();
  }

  if (submittal.status === "submitted") {
    void admin
      .from("submittals")
      .update({ viewed_at: new Date().toISOString() })
      .eq("share_token", token)
      .is("viewed_at", null);
  }

  const { data: fileRows } = await admin
    .from("submittal_files")
    .select("id, filename, storage_path")
    .eq("submittal_id", submittal.id)
    .order("created_at");

  // Mint a signed URL per file (service role). 1-hour expiry is plenty for a
  // review session; the portal link itself is the durable credential.
  const files: { id: string; filename: string; url: string }[] = [];
  for (const f of (fileRows ?? []) as { id: string; filename: string; storage_path: string }[]) {
    const { data, error } = await admin.storage
      .from("submittal-files")
      .createSignedUrl(f.storage_path, 3600);
    if (!error && data?.signedUrl) {
      files.push({ id: f.id, filename: f.filename, url: data.signedUrl });
    }
  }

  let orgName = "";
  let orgEmail: string | null = null;
  if (submittal.organization_id) {
    const { data: orgRow } = await admin
      .from("organizations")
      .select("name, email")
      .eq("id", submittal.organization_id)
      .maybeSingle();
    if (orgRow?.name) orgName = orgRow.name as string;
    orgEmail = (orgRow?.email as string | null)?.trim() || null;
  }

  const jobName =
    (submittal.jobs as unknown as { name: string } | null)?.name ??
    submittal.title ??
    "the project";

  const dispositionLabel = (d: string | null) => {
    if (!d) return null;
    const map: Record<string, string> = {
      approved: "Approved",
      approved_as_noted: "Approved as Noted",
      revise_resubmit: "Revise & Resubmit",
      rejected: "Rejected",
    };
    return map[d] ?? d;
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      submitted: { label: "Awaiting your review", cls: "bg-blue-100 text-blue-700" },
      returned: { label: "Returned", cls: "bg-amber-100 text-amber-700" },
      closed: { label: "Closed", cls: "bg-gray-100 text-gray-600" },
      draft: { label: "Draft", cls: "bg-gray-100 text-gray-600" },
    };
    const s = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-600" };
    return <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.cls}`}>{s.label}</span>;
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#4338ca" }}>
            <p className="text-white text-lg font-bold tracking-tight">{orgName}</p>
            <p className="text-indigo-200 text-xs uppercase tracking-wider mt-0.5">
              Submittal for your review
            </p>
          </div>

          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                {submittal.submittal_number && (
                  <p className="text-xs uppercase tracking-wider text-gray-400">
                    Submittal #{submittal.submittal_number}
                  </p>
                )}
                <h1 className="text-xl font-bold text-gray-900">{submittal.title}</h1>
              </div>
              {statusBadge(submittal.status)}
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">Project</p>
                <p className="font-medium text-gray-900">{jobName}</p>
              </div>
              {submittal.csi_section && (
                <div>
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">CSI Section</p>
                  <p className="font-medium text-gray-900">{submittal.csi_section}</p>
                </div>
              )}
            </div>

            {submittal.description && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Description</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {submittal.description}
                </p>
              </div>
            )}

            {files.length > 0 && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Attached files</p>
                <ul className="space-y-2">
                  {files.map((f) => (
                    <li key={f.id}>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium break-all"
                      >
                        <span className="truncate">{f.filename}</span>
                        <span className="text-gray-400 font-normal">(open in new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {submittal.status === "returned" && submittal.returned_at && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                You returned this submittal as{" "}
                <strong>{dispositionLabel(submittal.disposition)}</strong> on{" "}
                {new Date(submittal.returned_at).toLocaleString()}.
              </p>
            )}

            {submittal.status === "submitted" && (
              <p className="text-xs text-gray-400">
                Review the files above, then return a disposition below.
              </p>
            )}
          </div>
        </div>

        {submittal.status === "submitted" && (
          <div className="mt-4">
            <SubmittalReturnButtons token={token} />
          </div>
        )}

        {orgEmail && (
          <p className="text-center text-[11px] text-gray-400 mt-4">
            Questions? Contact {orgName} at {orgEmail}.
          </p>
        )}
      </div>
    </div>
  );
}