"use client";

import { useState, useEffect, use, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import SendVisitPhotos from "@/components/SendVisitPhotos";
import dynamic from "next/dynamic";
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
  Send,
} from "lucide-react";
import LawnPropertyDetails, {
  type LawnJob,
} from "@/components/LawnPropertyDetails";

// Only mounts after "Skip" is pressed — kept out of the first-load bundle.
const SkipReasonPicker = dynamic(
  () => import("@/components/SkipReasonPicker"),
  {
    ssr: false,
    loading: () => (
      <div className="h-[104px] rounded-lg bg-amber-50 border border-amber-200 animate-pulse" />
    ),
  }
);

type Visit = {
  id: string;
  job_id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  completed_at: string | null;
  notes: string | null;
  skip_reason: string | null;
  recurring_schedule_id: string;
  // customers is reached through jobs (lawn_visits has job_id, no customer_id)
  // — embed jobs(name, address, customers(name, contact_email, phone)).
  // contact_email/phone feed the "Send to customer" channel picker.
  jobs: {
    name: string;
    address: string | null;
    customers: {
      name: string | null;
      contact_email: string | null;
      phone: string | null;
    } | null;
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
  // Crew picker reads crew_members (not profiles) so scheduling-only members
  // (no app login, user_id null) appear alongside linked app-user crew. See
  // crew_members.sql: linked members keep id === profiles.id, so crew_id still
  // equals auth.uid() for the My-Route ownership check.
  const [crew, setCrew] = useState<{ id: string; name: string; user_id: string | null }[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [isOffice, setIsOffice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [property, setProperty] = useState<LawnJob | null>(null);
  const [sendingOMW, setSendingOMW] = useState(false);
  const [showSkipPicker, setShowSkipPicker] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data: v } = await supabase
      .from("lawn_visits")
      .select(
        "id, job_id, due_date, status, crew_id, completed_at, notes, skip_reason, recurring_schedule_id, jobs(name, address, customers(name, contact_email, phone))"
      )
      .eq("id", id)
      .maybeSingle();
    if (!v) return;
    setVisit(v as unknown as Visit);

    const [{ data: photoRows }, { data: crewRows }, { data: lawnJob }] = await Promise.all([
      supabase
        .from("photos")
        .select("id, storage_path, caption")
        .eq("visit_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("crew_members")
        .select("id, name, user_id")
        .order("name"),
      supabase
        .from("lawn_jobs")
        .select("*")
        .eq("id", (v as unknown as Visit).job_id)
        .maybeSingle(),
    ]);
    setPhotos((photoRows as unknown as Photo[]) ?? []);
    setCrew((crewRows as { id: string; name: string; user_id: string | null }[]) ?? []);
    setProperty((lawnJob as unknown as LawnJob | null) ?? null);
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
      const officeLike =
        role === "office" || role === "admin" || role === "super_admin";
      if (!officeLike && role !== "crew" && role !== "superintendent") {
        router.push("/dashboard");
        return;
      }
      // Field crew may only open a visit assigned directly to them (crew_id).
      if (!officeLike) {
        const { data: own } = await supabase
          .from("lawn_visits")
          .select("crew_id")
          .eq("id", id)
          .maybeSingle();
        const crewId = (own as unknown as { crew_id: string | null } | null)?.crew_id ?? null;
        if (crewId !== user.id) {
          router.push("/dashboard");
          return;
        }
      }
      setIsOffice(officeLike);
      setAuthorized(true);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function updateStatus(status: string, skipReason?: string) {
    if (!visit) return;
    setBusy(true);
    // Both office and crew route through the /status API. The API admits
    // office/PM (full status + reschedule) and the assigned crew/superintendent
    // (status-only, server-side ownership check) and — critically — fires the
    // customer notification suite (service_complete + review_request, or
    // service_skipped with the reason) when a visit is marked done/skipped,
    // regardless of who marked it. The old crew path did a direct RLS update
    // that bypassed the API, so crew-done visits never emailed the customer.
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visit.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          status === "skipped" ? { status, skip_reason: skipReason } : { status }
        ),
      });
    } catch {
      setBusy(false);
      toast.error("Failed: network error");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    const completed_at = status === "done" ? new Date().toISOString() : null;
    setVisit({
      ...visit,
      status,
      completed_at,
      skip_reason: status === "skipped" ? skipReason?.trim() || null : null,
    });
    setShowSkipPicker(false);
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
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visit.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_date: moveDate }),
      });
    } catch {
      setBusy(false);
      toast.error("Failed: network error");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (data.code === "23505") {
        toast.error("A visit already exists on that date for this schedule");
      } else {
        toast.error(`Failed: ${data.error ?? res.statusText}`);
      }
      return;
    }
    setVisit({ ...visit, due_date: moveDate });
    setMoving(false);
    setMoveDate("");
    toast.success("Visit moved");
  }

  async function onMyWay() {
    if (!visit) return;
    setSendingOMW(true);
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visit.id}/on-my-way`, {
        method: "POST",
      });
    } catch {
      setSendingOMW(false);
      toast.error("Failed: network error");
      return;
    }
    setSendingOMW(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok: boolean;
      reason?: string;
      error?: string;
    };
    if (data.ok) {
      toast.success("On-my-way sent");
    } else {
      // Surface the real skip/failure reason from the notification suite. The
      // route returns one of: disabled | opt-out | no-contact | no-template |
      // "no customer" | a send error message (e.g. "email not configured") |
      // "not sent". Map the known ones to friendly text; fall back to showing
      // the raw reason so nothing is ever hidden behind "email not sent".
      const reason = data.reason ?? data.error ?? "email not sent";
      const friendly: Record<string, string> = {
        "no customer": "No customer on this job",
        disabled: "Notifications are turned off — enable them in Settings",
        "opt-out": "Customer opted out of email notifications",
        "no-contact": "No email on file for this customer",
        "no-template": "No active email template — add one in Notifications",
        "not sent": "Email not sent",
        "email not configured":
          "Email not configured — set RESEND_API_KEY + RESEND_FROM in Vercel",
      };
      const msg = friendly[reason] ?? `Failed: ${reason}`;
      // Soft skips (no customer / no contact / opt-out) are expected, not errors.
      const soft = reason === "no customer" || reason === "no-contact" || reason === "opt-out";
      if (soft) toast.warning(msg);
      else toast.error(msg);
    }
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
  const custEmail = visit.jobs?.customers?.contact_email ?? null;
  const custPhone = visit.jobs?.customers?.phone ?? null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title={jobName}
        backHref={
          isOffice
            ? `/lawn/schedules/${visit.recurring_schedule_id}`
            : "/lawn/my-route"
        }
        backLabel={isOffice ? "Schedule" : "Route"}
      />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
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

          {visit.status === "skipped" && visit.skip_reason && (
            <p className="text-xs text-gray-500">
              Skipped · {visit.skip_reason}
            </p>
          )}

          {/* Status actions */}
          {showSkipPicker ? (
            <SkipReasonPicker
              busy={busy}
              onConfirm={(reason) => updateStatus("skipped", reason)}
              onCancel={() => setShowSkipPicker(false)}
            />
          ) : (
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
              {isOffice && visit.status !== "skipped" && (
                <button
                  type="button"
                  onClick={() => setShowSkipPicker(true)}
                  disabled={busy}
                  className="bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  <X className="w-4 h-4" />
                  Skip
                </button>
              )}
              {isOffice && visit.status !== "pending" && (
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
          )}

          {/* Move date + on-my-way — office only */}
          {isOffice && (moving ? (
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
            <div className="flex items-center justify-between pt-1">
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
              <button
                type="button"
                onClick={onMyWay}
                disabled={busy || sendingOMW}
                className="text-sm text-green-700 font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                {sendingOMW ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                On my way
              </button>
            </div>
          ))}
        </div>

        {/* Property profile (lawn_jobs 1:1) */}
        <LawnPropertyDetails
          jobId={visit.job_id}
          initial={property}
          canEdit={isOffice}
        />

        {/* Crew assignment — office only */}
        {isOffice && crew.length > 0 && (
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
                    {c.name}
                    {c.user_id ? "" : " — no app login"}
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
            <>
              <SignedPhotoGrid photos={photos} />
              {/* Send the visit's photo-portal link + a short note to the
                  customer. Requires at least one photo (enforced here by only
                  rendering when photos.length > 0, and again server-side). */}
              <SendVisitPhotos
                visitId={visit.id}
                customerEmail={custEmail}
                customerPhone={custPhone}
              />
            </>
          ) : (
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <Images className="w-3.5 h-3.5" />
              No photos attached to this visit yet.
            </p>
          )}
        </div>

        {isOffice && (
          <Link
            href={`/jobs/${visit.job_id}`}
            className="block text-center text-sm text-blue-600 font-medium py-2"
          >
            Open job →
          </Link>
        )}
      </main>
    </div>
  );
}
