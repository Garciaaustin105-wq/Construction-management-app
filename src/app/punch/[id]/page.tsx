"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import StatusBadge from "@/components/StatusBadge";
import { FIELD_MGMT } from "@/lib/roles";

type PunchItem = {
  id: string;
  job_id: string;
  title: string;
  description: string | null;
  location: string | null;
  assigned_to: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
};

type Crew = { id: string; full_name: string };
type Photo = { id: string; storage_path: string; caption: string | null; url: string };

function PunchItemForm({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedJob = searchParams.get("job") ?? "";
  const toast = useToast();
  const [item, setItem] = useState<PunchItem | null>(null);
  const [crew, setCrew] = useState<Crew[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [canEdit, setCanEdit] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [saving, setSaving] = useState(false);

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
      if (role === "customer") {
        router.push("/dashboard");
        return;
      }
      setCanEdit(FIELD_MGMT.has(role));
      setAuthorized(true);

      const [{ data: itemRow }, { data: crewRows }, { data: photoRows }] = await Promise.all([
        supabase
          .from("punch_items")
          .select(
            "id, job_id, title, description, location, assigned_to, status, priority, due_date, created_by, created_at, completed_at"
          )
          .eq("id", paramId)
          .single(),
        supabase
          .from("profiles")
          .select("id, full_name")
          .in("role", ["crew", "superintendent"])
          .order("full_name"),
        supabase
          .from("photos")
          .select("id, storage_path, caption")
          .eq("punch_item_id", paramId),
      ]);

      if (!itemRow) {
        toast.error("Punch item not found");
        router.push("/punch");
        return;
      }
      setItem(itemRow as unknown as PunchItem);
      setCrew((crewRows ?? []) as unknown as Crew[]);

      const pics: Photo[] = [];
      for (const p of (photoRows ?? []) as unknown as { id: string; storage_path: string; caption: string | null }[]) {
        const { data } = await supabase.storage.from("job-photos").createSignedUrl(p.storage_path, 3600);
        if (data?.signedUrl) pics.push({ id: p.id, storage_path: p.storage_path, caption: p.caption, url: data.signedUrl });
      }
      setPhotos(pics);
    })();
  }, [params, router, toast]);

  async function save() {
    if (!item) return;
    setSaving(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("punch_items")
      .update({
        title: item.title,
        description: item.description || null,
        location: item.location || null,
        assigned_to: item.assigned_to || null,
        priority: item.priority,
        due_date: item.due_date || null,
        status: item.status,
        updated_at: new Date().toISOString(),
        completed_at: item.status === "complete" ? new Date().toISOString() : null,
        completed_by: item.status === "complete" ? userId : null,
      })
      .eq("id", item.id);
    setSaving(false);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success("Saved");
    router.refresh();
  }

  async function advance() {
    if (!item) return;
    const next =
      item.status === "open" ? "in_progress" : item.status === "in_progress" ? "complete" : "open";
    setSaving(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("punch_items")
      .update({
        status: next,
        updated_at: new Date().toISOString(),
        completed_at: next === "complete" ? new Date().toISOString() : null,
        completed_by: next === "complete" ? userId : null,
      })
      .eq("id", item.id);
    setSaving(false);
    if (error) {
      toast.error(`Update failed: ${error.message}`);
      return;
    }
    setItem({ ...item, status: next });
    toast.success("Status updated");
  }

  async function attach(file: File) {
    if (!item) return;
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${item.job_id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("job-photos").upload(path, file);
    if (upErr) {
      toast.error(`Upload failed: ${upErr.message}`);
      return;
    }
    await supabase
      .from("photos")
      .insert({ job_id: item.job_id, storage_path: path, punch_item_id: item.id, uploaded_by: userId });
    const { data } = await supabase.storage.from("job-photos").createSignedUrl(path, 3600);
    if (data?.signedUrl) {
      setPhotos((prev) => [...prev, { id: crypto.randomUUID(), storage_path: path, caption: null, url: data.signedUrl }]);
    }
    toast.success("Photo attached");
  }

  if (!authorized)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  if (!item) return null;

  const backHref = preselectedJob ? `/jobs/${preselectedJob}` : "/punch";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(backHref)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{preselectedJob ? "Back to job" : "Punch List"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          Punch Item
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        <div className="bg-white rounded-lg shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-500">Status</span>
            <StatusBadge status={item.status} />
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Title</span>
            {canEdit ? (
              <input
                type="text"
                value={item.title}
                onChange={(e) => setItem({ ...item, title: e.target.value })}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            ) : (
              <p className="mt-1 text-sm text-gray-900">{item.title}</p>
            )}
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Description</span>
            {canEdit ? (
              <textarea
                value={item.description ?? ""}
                onChange={(e) => setItem({ ...item, description: e.target.value })}
                rows={3}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            ) : (
              <p className="mt-1 text-sm text-gray-900 whitespace-pre-wrap">{item.description ?? "—"}</p>
            )}
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Location</span>
            {canEdit ? (
              <input
                type="text"
                value={item.location ?? ""}
                onChange={(e) => setItem({ ...item, location: e.target.value })}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            ) : (
              <p className="mt-1 text-sm text-gray-900">{item.location ?? "—"}</p>
            )}
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Assigned to</span>
            {canEdit ? (
              <select
                value={item.assigned_to ?? ""}
                onChange={(e) => setItem({ ...item, assigned_to: e.target.value || null })}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              >
                <option value="">Unassigned</option>
                {crew.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 text-sm text-gray-900">
                {crew.find((c) => c.id === item.assigned_to)?.full_name ?? "Unassigned"}
              </p>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Priority</span>
              {canEdit ? (
                <select
                  value={item.priority}
                  onChange={(e) => setItem({ ...item, priority: e.target.value })}
                  className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              ) : (
                <p className="mt-1 text-sm text-gray-900 capitalize">{item.priority}</p>
              )}
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Due date</span>
              {canEdit ? (
                <input
                  type="date"
                  value={item.due_date ? item.due_date.slice(0, 10) : ""}
                  onChange={(e) =>
                    setItem({ ...item, due_date: e.target.value || null })
                  }
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
                />
              ) : (
                <p className="mt-1 text-sm text-gray-900">
                  {item.due_date ? new Date(item.due_date).toLocaleDateString() : "—"}
                </p>
              )}
            </label>
          </div>

          {canEdit && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Status</span>
              <select
                value={item.status}
                onChange={(e) => setItem({ ...item, status: e.target.value })}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="complete">Complete</option>
                <option value="void">Void</option>
              </select>
            </label>
          )}
        </div>

        {photos.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Photos</h2>
            <div className="grid grid-cols-2 gap-2">
              {photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  {/* Signed URL (createSignedUrl, 1h) — the rotating token makes
                      it a fresh optimizer cache key every hour, so plain <img>
                      with a fixed CSS box beats next/image here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.caption ?? ""}
                    loading="lazy"
                    decoding="async"
                    className="rounded w-full h-32 object-cover"
                  />
                </a>
              ))}
            </div>
          </div>
        )}

        {canEdit && (
          <div className="bg-white rounded-lg shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">Attach photo</h2>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) attach(f);
              }}
              className="block w-full text-sm"
            />
          </div>
        )}

        {canEdit && (
          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? "Saving..." : "Save changes"}
          </button>
        )}

        {!canEdit && item.status !== "void" && (
          <button
            onClick={advance}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {item.status === "open" ? "Start" : item.status === "in_progress" ? "Mark Complete" : "Reopen"}
          </button>
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
      <PunchItemForm params={params} />
    </Suspense>
  );
}