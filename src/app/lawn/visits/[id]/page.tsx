"use client";

import { useState, useEffect, use, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import { useToast } from "@/components/Toast";
import { validateUpload } from "@/lib/uploadValidate";
import { normalizeImage } from "@/lib/normalizeImage";
import {
  Loader2,
  Check,
  X,
  Calendar,
  Camera,
  Images,
  RotateCcw,
} from "lucide-react";

type Visit = {
  id: string;
  job_id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  completed_at: string | null;
  notes: string | null;
  recurring_schedule_id: string;
  // customers is reached through jobs (lawn_visits has job_id, no customer_id)
  // — embed jobs(name, address, customers(name)).
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
  } | null;
};

type Photo = { id: string; storage_path: string; caption: string | null };

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

export default function VisitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [visit, setVisit] = useState<Visit | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [crew, setCrew] = useState<{ id: string; full_name: string | null; email: string }[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [uploading, setUploading] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data: v } = await supabase
      .from("lawn_visits")
      .select(
        "id, job_id, due_date, status, crew_id, completed_at, notes, recurring_schedule_id, jobs(name, address, customers(name))"
      )
      .eq("id", id)
      .maybeSingle();
    if (!v) return;
    setVisit(v as unknown as Visit);

    const [{ data: photoRows }, { data: crewRows }] = await Promise.all([
      supabase
        .from("photos")
        .select("id, storage_path, caption")
        .eq("visit_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("role", ["crew", "superintendent"])
        .order("full_name"),
    ]);
    setPhotos((photoRows as unknown as Photo[]) ?? []);
    setCrew((crewRows as { id: string; full_name: string | null; email: string }[]) ?? []);
  }

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      const role = profile?.role ?? "crew";
      if (role !== "office" && role !== "admin" && role !== "super_admin") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function updateStatus(status: string) {
    if (!visit) return;
    setBusy(true);
    const supabase = createClient();
    const patch: Record<string, unknown> = { status };
    if (status === "done") patch.completed_at = new Date().toISOString();
    if (status !== "done") patch.completed_at = null;
    const { error } = await supabase
      .from("lawn_visits")
      .update(patch)
      .eq("id", visit.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setVisit({ ...visit, status, completed_at: patch.completed_at as string | null });
    toast.success(
      status === "done"
        ? "Marked done"
        : status === "skipped"
        ? "Visit skipped"
        : "Reopened"
    );
  }

  async function confirmMove() {
    if (!visit || !moveDate) {
      toast.warning("Pick a new date");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_visits")
      .update({ due_date: moveDate })
      .eq("id", visit.id);
    setBusy(false);
    if (error) {
      if (error.code === "23505") {
        toast.error("A visit already exists on that date for this schedule");
      } else {
        toast.error(`Failed: ${error.message}`);
      }
      return;
    }
    setVisit({ ...visit, due_date: moveDate });
    setMoving(false);
    setMoveDate("");
    toast.success("Visit moved");
  }

  async function assignCrew(crewId: string) {
    if (!visit) return;
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_visits")
      .update({ crew_id: crewId || null })
      .eq("id", visit.id);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setVisit({ ...visit, crew_id: crewId || null });
  }

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0 || !visit) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      return;
    }
    setUploading(true);
    let ok = 0;
    let fail = 0;
    for (const file of Array.from(list)) {
      const v = validateUpload(file, "image");
      if (!v.ok) {
        toast.error(`${file.name}: ${v.error}`);
        continue;
      }
      const blob = await normalizeImage(file).catch(() => file);
      const path = `${visit.job_id}/${visit.id}/${Date.now()}-${ok}-${file.name.replace(/\.[^.]+$/, "")}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("job-photos")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (upErr) {
        fail++;
        continue;
      }
      const { error: dbErr } = await supabase.from("photos").insert({
        job_id: visit.job_id,
        uploaded_by: user.id,
        storage_path: path,
        caption: null,
        visit_id: visit.id,
      });
      if (dbErr) fail++;
      else ok++;
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (ok > 0) {
      toast.success(`Uploaded ${ok} photo${ok > 1 ? "s" : ""}${fail > 0 ? ` · ${fail} failed` : ""}`);
      await load();
    } else if (fail > 0) {
      toast.error(`Upload failed for ${fail} photo${fail > 1 ? "s" : ""}`);
    }
  }

  if (!authorized || !visit) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  const jobName = visit.jobs?.name ?? "—";
  const jobAddress = visit.jobs?.address ?? null;
  const custName = visit.jobs?.customers?.name ?? null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title={jobName} backHref={`/lawn/schedules/${visit.recurring_schedule_id}`} backLabel="Schedule" />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex justify-between items-start">
            <div className="min-w-0">
              <p className="text-xs text-gray-500">{custName ?? "—"}</p>
              <p className="font-semibold text-gray-900 flex items-center gap-1.5">
                <Calendar className="w-4 h-4 text-gray-400" />
                {visit.due_date}
              </p>
              {jobAddress && <p className="text-xs text-gray-500">{jobAddress}</p>}
            </div>
            <span
              className={`text-[10px] font-semibold px-2 py-1 rounded ${
                STATUS_CHIP[visit.status] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {visit.status}
            </span>
          </div>

          {/* Status actions */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            {visit.status !== "done" && (
              <button
                type="button"
                onClick={() => updateStatus("done")}
                disabled={busy}
                className="bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                Mark done
              </button>
            )}
            {visit.status !== "skipped" && (
              <button
                type="button"
                onClick={() => updateStatus("skipped")}
                disabled={busy}
                className="bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <X className="w-4 h-4" />
                Skip
              </button>
            )}
            {visit.status !== "pending" && (
              <button
                type="button"
                onClick={() => updateStatus("pending")}
                disabled={busy}
                className="bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <RotateCcw className="w-4 h-4" />
                Reopen
              </button>
            )}
          </div>

          {/* Move date */}
          {moving ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={moveDate}
                onChange={(e) => setMoveDate(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              <button
                type="button"
                onClick={confirmMove}
                disabled={busy}
                className="text-sm text-blue-600 font-semibold"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoving(false);
                  setMoveDate("");
                }}
                className="text-sm text-gray-500"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMoving(true);
                setMoveDate(visit.due_date);
              }}
              disabled={busy}
              className="text-sm text-blue-600 font-medium"
            >
              Move date
            </button>
          )}
        </div>

        {/* Crew assignment */}
        {crew.length > 0 && (
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Assign crew</span>
              <select
                value={visit.crew_id ?? ""}
                onChange={(e) => assignCrew(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="">— Unassigned —</option>
                {crew.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name ?? c.email}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {/* Before / after photos */}
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Before / after photos</h2>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-2"
            >
              <Camera className="w-4 h-4" />
              Take / add photos
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              onChange={(e) => handleFiles(e.target.files)}
              className="hidden"
            />
          </div>
          {uploading && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Uploading…
            </div>
          )}
          {photos.length > 0 ? (
            <SignedPhotoGrid photos={photos} />
          ) : (
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <Images className="w-3.5 h-3.5" />
              No photos attached to this visit yet.
            </p>
          )}
        </div>

        <Link
          href={`/jobs/${visit.job_id}`}
          className="block text-center text-sm text-blue-600 font-medium py-2"
        >
          Open job →
        </Link>
      </main>
    </div>
  );
}