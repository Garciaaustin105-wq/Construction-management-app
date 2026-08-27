"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import HighlightsHeader from "@/components/ui/HighlightsHeader";
import Button from "@/components/ui/Button";
// Labels, tones and the valid-transition table all come from the lifecycle
// module — the single source shared with the list page.
import {
  SUBMITTAL_STATUS_LABEL,
  SUBMITTAL_STATUS_TONE,
  validTransitions,
  type SubmittalStatus,
} from "@/lib/lifecycles/submittal";
import { OFFICE_OR_PM } from "@/lib/roles";
import EmailPreviewModal from "@/components/EmailPreviewModal";

type Submittal = {
  id: string;
  job_id: string;
  submittal_number: string | null;
  title: string;
  description: string | null;
  csi_section: string | null;
  cost_code_id: string | null;
  status: string;
  disposition: string | null;
  ball_in_court: string;
  sent_at: string | null;
  viewed_at: string | null;
  returned_at: string | null;
  created_at: string;
};

type CostCode = { id: string; code: string; name: string };
type SubFile = {
  id: string;
  filename: string;
  storage_path: string;
  created_at: string;
  url: string | null;
};

function SubmittalForm({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedJob = searchParams.get("job") ?? "";
  const toast = useToast();
  const [sub, setSub] = useState<Submittal | null>(null);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [files, setFiles] = useState<SubFile[]>([]);
  const [userId, setUserId] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  // Send-to-reviewer form (replaces the old window.prompt). The reviewer's
  // email is office-typed (there is no architect entity); the optional note is
  // threaded into the email (and the preview) via the route's `message` field.
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [note, setNote] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const { id: paramId } = await params;
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      setUserId(user.id);
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      const role = profile?.role ?? "crew";
      if (!OFFICE_OR_PM.has(role)) {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const [{ data: subRow }, { data: ccRows }, { data: fileRows }] = await Promise.all([
        supabase
          .from("submittals")
          .select(
            "id, job_id, submittal_number, title, description, csi_section, cost_code_id, status, disposition, ball_in_court, sent_at, viewed_at, returned_at, created_at"
          )
          .eq("id", paramId)
          .single(),
        supabase.from("cost_codes").select("id, code, name").order("code"),
        supabase
          .from("submittal_files")
          .select("id, filename, storage_path, created_at")
          .eq("submittal_id", paramId),
      ]);

      if (!subRow) {
        toast.error("Submittal not found");
        router.push("/submittals");
        return;
      }
      setSub(subRow as unknown as Submittal);
      setCostCodes((ccRows ?? []) as unknown as CostCode[]);

      const withUrls: SubFile[] = [];
      for (const f of (fileRows ?? []) as unknown as {
        id: string;
        filename: string;
        storage_path: string;
        created_at: string;
      }[]) {
        const { data } = await supabase.storage
          .from("submittal-files")
          .createSignedUrl(f.storage_path, 3600);
        withUrls.push({
          id: f.id,
          filename: f.filename,
          storage_path: f.storage_path,
          created_at: f.created_at,
          url: data?.signedUrl ?? null,
        });
      }
      setFiles(withUrls);
    })();
  }, [params, router, toast]);

  async function save() {
    if (!sub) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("submittals")
      .update({
        title: sub.title,
        description: sub.description || null,
        csi_section: sub.csi_section || null,
        cost_code_id: sub.cost_code_id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.id);
    setBusy(false);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success("Saved");
    router.refresh();
  }

  // Returns true on success (the EmailPreviewModal closes on true), false on
  // failure (the modal stays open; the toast below already explained it).
  async function sendToArchitect(): Promise<boolean> {
    if (!sub) return false;
    const to = reviewerEmail.trim();
    if (!to) {
      toast.error("Enter the reviewer's email");
      return false;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/submittals/${sub.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, message: note.trim() || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? "Send failed");
        return false;
      }
      toast.success("Sent to reviewer");
      setSub({ ...sub, status: "submitted", ball_in_court: "architect" });
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function closeSubmittal() {
    if (!sub) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("submittals")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", sub.id);
    setBusy(false);
    if (error) {
      toast.error(`Close failed: ${error.message}`);
      return;
    }
    setSub({ ...sub, status: "closed" });
    toast.success("Submittal closed");
    router.refresh();
  }

  async function attach(list: FileList) {
    if (!sub || list.length === 0) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const added: SubFile[] = [];
    for (const file of Array.from(list)) {
      const path = `${sub.job_id}/${sub.id}/${crypto.randomUUID()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("submittal-files").upload(path, file);
      if (upErr) {
        toast.error(`Upload failed: ${upErr.message}`);
        continue;
      }
      const { error: insErr } = await supabase.from("submittal_files").insert({
        job_id: sub.job_id,
        submittal_id: sub.id,
        filename: file.name,
        storage_path: path,
        uploaded_by: userId,
      });
      if (insErr) {
        toast.error(`File record failed: ${insErr.message}`);
        continue;
      }
      const { data } = await supabase.storage.from("submittal-files").createSignedUrl(path, 3600);
      added.push({
        id: crypto.randomUUID(),
        filename: file.name,
        storage_path: path,
        created_at: new Date().toISOString(),
        url: data?.signedUrl ?? null,
      });
    }
    setFiles((prev) => [...prev, ...added]);
    setBusy(false);
    if (added.length) toast.success(`${added.length} file(s) attached`);
  }

  async function deleteFile(id: string, path: string) {
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    await supabase.storage.from("submittal-files").remove([path]);
    await supabase.from("submittal_files").delete().eq("id", id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setBusy(false);
    toast.success("File removed");
  }

  if (!authorized)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  if (!sub) return null;

  const editable = sub.status === "draft" || sub.status === "returned";
  const backHref = preselectedJob ? `/jobs/${preselectedJob}` : "/submittals";

  // The DB column is `text`; the lifecycle module owns the domain.
  const status = sub.status as SubmittalStatus;
  const nextStatuses = validTransitions(status);
  // Which status action renders = status-valid (lifecycle) x role-allowed.
  // Role is unchanged: the page already bounced anyone outside OFFICE_OR_PM,
  // so reaching here IS the role permission for both actions.
  const canSend = nextStatuses.includes("submitted");
  const canClose = nextStatuses.includes("closed");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(backHref)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{preselectedJob ? "Back to job" : "Submittals"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[40%]">
          {sub.submittal_number ?? "Submittal"}
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        <HighlightsHeader
          title={sub.title || sub.submittal_number || "Submittal"}
          subtitle={sub.submittal_number ?? undefined}
          status={{
            label: SUBMITTAL_STATUS_LABEL[status] ?? sub.status,
            tone: SUBMITTAL_STATUS_TONE[status] ?? "neutral",
          }}
          accent={SUBMITTAL_STATUS_TONE[status] ?? "brand"}
          fields={[
            { label: "Created", value: new Date(sub.created_at).toLocaleDateString() },
            {
              label: "Sent",
              value: sub.sent_at ? new Date(sub.sent_at).toLocaleDateString() : "—",
            },
            {
              label: "Returned",
              value: sub.returned_at
                ? new Date(sub.returned_at).toLocaleDateString()
                : "—",
            },
            { label: "Ball in court", value: sub.ball_in_court },
          ]}
          actions={
            <>
              {canClose && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={closeSubmittal}
                  disabled={busy}
                  size="sm"
                >
                  Close Submittal
                </Button>
              )}
            </>
          }
        />

        <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
          {sub.sent_at && (
            <p className="text-xs text-blue-600">
              Sent to reviewer {new Date(sub.sent_at).toLocaleDateString()}
            </p>
          )}
          {sub.viewed_at && (
            <p className="text-xs text-gray-500">
              Viewed by reviewer {new Date(sub.viewed_at).toLocaleDateString()}
            </p>
          )}
          {sub.returned_at && sub.disposition && (
            <p className="text-xs text-amber-700">
              Returned: {sub.disposition.replace(/_/g, " ")} ·{" "}
              {new Date(sub.returned_at).toLocaleDateString()}
            </p>
          )}
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
            Ball in court: {sub.ball_in_court}
          </span>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-4 space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Title</span>
            <input
              type="text"
              value={sub.title}
              disabled={!editable}
              onChange={(e) => setSub({ ...sub, title: e.target.value })}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Description</span>
            <textarea
              value={sub.description ?? ""}
              disabled={!editable}
              onChange={(e) => setSub({ ...sub, description: e.target.value })}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">CSI Section</span>
            <input
              type="text"
              value={sub.csi_section ?? ""}
              disabled={!editable}
              onChange={(e) => setSub({ ...sub, csi_section: e.target.value })}
              placeholder="e.g. 09 30 00"
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Cost code</span>
            <select
              value={sub.cost_code_id ?? ""}
              disabled={!editable}
              onChange={(e) => setSub({ ...sub, cost_code_id: e.target.value || null })}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            >
              <option value="">None</option>
              {costCodes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Files</h2>
          {files.length === 0 ? (
            <p className="text-sm text-gray-400">No files attached.</p>
          ) : (
            <div className="space-y-2">
              {files.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-2">
                  <a
                    href={f.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-600 underline truncate"
                  >
                    {f.filename}
                  </a>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => deleteFile(f.id, f.storage_path)}
                      disabled={busy}
                      className="text-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {editable && (
            <input
              type="file"
              multiple
              accept=".pdf,image/*"
              onChange={(e) => {
                if (e.target.files) attach(e.target.files);
              }}
              className="mt-3 block w-full text-sm"
            />
          )}
        </div>

        {editable && (
          <button
            onClick={save}
            disabled={busy}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? "Saving..." : "Save changes"}
          </button>
        )}

        {canSend && (
          <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase">Send to reviewer</h2>
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-600">
                Reviewer email
              </span>
              <input
                type="email"
                value={reviewerEmail}
                onChange={(e) => setReviewerEmail(e.target.value)}
                placeholder="architect@example.com"
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-600">
                Personal note (optional)
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Added to the top of the email..."
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <button
              onClick={() => setPreviewOpen(true)}
              disabled={busy}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Send to Reviewer
            </button>
          </div>
        )}

        {canSend && (
          <EmailPreviewModal
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            kind="submittal"
            recordId={sub.id}
            message={note.trim() || null}
            toLabel={reviewerEmail.trim() ? `To: ${reviewerEmail.trim()}` : undefined}
            sendLabel="Send to Reviewer"
            canSend={!!reviewerEmail.trim()}
            onConfirm={sendToArchitect}
          />
        )}

      </main>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500">Loading...</p>
        </div>
      }
    >
      <SubmittalForm params={params} />
    </Suspense>
  );
}