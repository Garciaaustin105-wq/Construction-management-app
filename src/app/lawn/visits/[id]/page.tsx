"use client";

import { useState, useEffect, use, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import PageContainer from "@/components/PageContainer";
import HighlightsHeader from "@/components/ui/HighlightsHeader";
import Button from "@/components/ui/Button";
// Labels, tones and the valid-transition table all come from the lifecycle
// module — the single source shared with the lawn list views. The tones
// match the hand-rolled STATUS_CHIP map this replaced.
import {
  LAWN_VISIT_STATUS_LABEL,
  LAWN_VISIT_STATUS_TONE,
  validTransitions,
  type LawnVisitStatus,
} from "@/lib/lifecycles/lawn-visit";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import SendVisitPhotos from "@/components/SendVisitPhotos";
import dynamic from "next/dynamic";
import { useToast } from "@/components/Toast";
import { validateUpload } from "@/lib/uploadValidate";
import { normalizeImage } from "@/lib/normalizeImage";
import {
  Loader2,
  Check,
  Play,
  X,
  Camera,
  Images,
  RotateCcw,
  Send,
} from "lucide-react";
import LawnPropertyDetails, {
  type LawnJob,
} from "@/components/LawnPropertyDetails";
import { manHours } from "@/lib/manHours";

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
  /** Stamped by the Start action. Deliberately does NOT move `status` — the
   *  done -> pending lifecycle in src/lib/lifecycles/lawn-visit.ts
   *  is untouched. On-site time is completed_at - started_at. */
  started_at: string | null;
  /** Measured on-site window (geofence). Written by any crew phone's location
   *  pings and does not depend on anyone tapping Start/Done — this is the
   *  figure pricing trusts; started/completed is only the labelled fallback. */
  on_site_first_at: string | null;
  on_site_last_at: string | null;
  /** Auth user ids of phones recorded on site. length > 1 is the evidence the
   *  measurement is real. */
  on_site_user_ids: string[] | null;
  /** too_long / too_short / no_departure — set by the measurement pipeline.
   *  A flag usually means we lack a lot size, never that the crew slacked. */
  measurement_flag: string | null;
  /** Optional appointment window ("between 9 and 11"). `time` columns, so
   *  these arrive as "HH:MM:SS"; NULL = any time that day. */
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  notes: string | null;
  skip_reason: string | null;
  recurring_schedule_id: string;
  /** Embedded so the visit can resolve its estimated service time. */
  recurring_schedules: {
    estimated_duration_minutes: number | null;
    service_type: string | null;
  } | null;
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



export default function VisitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  // Which button opened the picker. A ref, not state: it is read once in the
  // change handler and must not re-render the page between tap and capture.
  const pendingPhase = useRef<"before" | "after" | null>(null);

  const [visit, setVisit] = useState<Visit | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  // Crew picker reads crew_members (not profiles) so scheduling-only members
  // (no app login, user_id null) appear alongside linked app-user crew. See
  // crew_members.sql: linked members keep id === profiles.id, so crew_id still
  // equals auth.uid() for the My-Route ownership check.
  const [crew, setCrew] = useState<{ id: string; name: string; user_id: string | null }[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [isOffice, setIsOffice] = useState(false);
  const [serviceDurations, setServiceDurations] = useState<
    { name: string; default_duration_minutes: number | null }[]
  >([]);
  const [starting, setStarting] = useState(false);
  const [editingWindow, setEditingWindow] = useState(false);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [savingWindow, setSavingWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [property, setProperty] = useState<LawnJob | null>(null);
    const [sendingOMW, setSendingOMW] = useState(false);
  const [showSkipPicker, setShowSkipPicker] = useState(false);
  // Crew size for man-hours, joined from time_entries (see load()). null =
  // unknown: no covering shift, or the covering shift never recorded a size.
  // The display MUST treat null as missing, never as 1 — a wrong multiplier
  // silently under-prices the job while a missing one is visibly chaseable.
  const [crewSize, setCrewSize] = useState<number | null>(null);

  async function load() {
    const supabase = createClient();
    const { data: v } = await supabase
      .from("lawn_visits")
      .select(
        "id, job_id, due_date, status, crew_id, completed_at, started_at, on_site_first_at, on_site_last_at, on_site_user_ids, measurement_flag, scheduled_window_start, scheduled_window_end, notes, skip_reason, recurring_schedule_id, recurring_schedules(estimated_duration_minutes, service_type), jobs(name, address, customers(name, contact_email, phone))"
      )
      .eq("id", id)
      .maybeSingle();
    if (!v) return;
    setVisit(v as unknown as Visit);

    // ── crew_size join ──────────────────────────────────────────────────────
    // crew_size lives on time_entries, not on the visit. Find the SHIFT that
    // covers this visit (RLS-scoped to the org — no manual org filter): the
    // visit's measured arrival must fall between clock_in_at and
    // coalesce(clock_out_at, now()). When several shifts cover it (each crew
    // member clocks their own), prefer the visit's assigned crew member —
    // crew size is recorded on the lead's shift — else the latest clock-in.
    // Only measured visits join at all: without on_site_first_at there is no
    // measured window and therefore no man-hour claim to make.
    const anchor = (v as unknown as Visit).on_site_first_at;
    if (anchor) {
      const { data: shifts } = await supabase
        .from("time_entries")
        .select("id, user_id, crew_size, clock_in_at")
        .lte("clock_in_at", anchor)
        .or(`clock_out_at.is.null,clock_out_at.gte.${anchor}`)
        .order("clock_in_at", { ascending: false });
      const covering = (shifts as { user_id: string | null; crew_size: number | null }[] | null) ?? [];
      const lead = covering.find(
        (s) => s.crew_size !== null && s.user_id === (v as unknown as Visit).crew_id
      );
      const any = covering.find((s) => s.crew_size !== null);
      setCrewSize(lead?.crew_size ?? any?.crew_size ?? null);
    }

    const [{ data: photoRows }, { data: crewRows }, { data: lawnJob }, { data: svcRows }] =
      await Promise.all([
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
      // Catalog defaults, so a visit whose schedule has no override can still
      // show the service's default length.
      supabase.from("lawn_services").select("name, default_duration_minutes"),
    ]);
    setPhotos((photoRows as unknown as Photo[]) ?? []);
    setCrew((crewRows as { id: string; name: string; user_id: string | null }[]) ?? []);
    setProperty((lawnJob as unknown as LawnJob | null) ?? null);
    setServiceDurations(
      (svcRows as { name: string; default_duration_minutes: number | null }[]) ?? []
    );
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

  async function updateStatus(status: LawnVisitStatus, skipReason?: string) {
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

  // Start stamps started_at only (status stays pending; lifecycle untouched).
  // Routed through /api/lawn/visits/[id]/start so the timestamp is
  // server-authoritative (matches completed_at, which /status stamps
  // server-side) and the "only when pending + not already started" guard is
  // enforced server-side — a client-stamped value would be tamper-able. The
  // route admits office/PM + the assigned crew, same as /status.
  async function startVisit() {
    if (!visit || visit.started_at) return;
    setStarting(true);
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visit.id}/start`, { method: "POST" });
    } catch {
      setStarting(false);
      toast.error("Failed: network error");
      return;
    }
    setStarting(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { started_at?: string };
    setVisit({ ...visit, started_at: data.started_at ?? null });
    toast.success("Started");
  }

  function openWindowEditor() {
    setWindowStart((visit?.scheduled_window_start ?? "").slice(0, 5));
    setWindowEnd((visit?.scheduled_window_end ?? "").slice(0, 5));
    setEditingWindow(true);
  }

  async function saveWindow() {
    if (!visit) return;
    // Both or neither — a half-open window can't be rendered as "between X and Y".
    if ((windowStart && !windowEnd) || (!windowStart && windowEnd)) {
      toast.warning("Set both a start and an end time, or clear both");
      return;
    }
    if (windowStart && windowEnd && windowStart >= windowEnd) {
      toast.warning("The window start must be before the end");
      return;
    }
    setSavingWindow(true);
    const supabase = createClient();
    const patch = {
      scheduled_window_start: windowStart || null,
      scheduled_window_end: windowEnd || null,
    };
    const { error } = await supabase
      .from("lawn_visits")
      .update(patch)
      .eq("id", visit.id);
    setSavingWindow(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setVisit({ ...visit, ...patch });
    setEditingWindow(false);
    toast.success(windowStart ? "Window saved" : "Window cleared");
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

  async function handleFiles(list: FileList | null, phase: "before" | "after" | null = null) {
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
        // Set by which button the crew pressed, never inferred. Crews upload in
        // a batch at the end, so created_at cannot tell a before from an after.
        phase,
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

  // lawn_visits.status has NO DB check constraint — the lifecycle module IS the
  // enforcement source here (see its header comment).
  const status = visit.status as LawnVisitStatus;
  const nextStatuses = validTransitions(status);
  // Which action renders = status-valid (lifecycle) x role-allowed. The role
  // split is unchanged: crew and office can both mark done; Skip and Reopen
  // stay office-only.
  // Effective service time: schedule override -> service catalog default ->
  // null. Same resolution the route planner uses, so the number the office
  // sees here is the number that feeds routing.
  const scheduleDuration = visit.recurring_schedules?.estimated_duration_minutes ?? null;
  const serviceDefaultDuration =
    serviceDurations.find((sv) => sv.name === visit.recurring_schedules?.service_type)
      ?.default_duration_minutes ?? null;
  const effectiveDuration = scheduleDuration ?? serviceDefaultDuration;

  // "HH:MM:SS" -> "9:00 AM". Wall-clock only; the date is due_date.
  function fmtTime(t: string | null): string | null {
    if (!t) return null;
    const [h, m] = t.split(":");
    const hour = Number(h);
    if (!Number.isFinite(hour)) return null;
    const suffix = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}:${m} ${suffix}`;
  }
  const windowLabel =
    visit.scheduled_window_start && visit.scheduled_window_end
      ? `${fmtTime(visit.scheduled_window_start)} – ${fmtTime(visit.scheduled_window_end)}`
      : null;

  // ── On-site time: MEASURED first, status-coupled second ────────────────────
  // The geofence window (on_site_first_at → on_site_last_at) is written by any
  // crew phone and needs nobody to remember Start or Done — it is the figure
  // pricing trusts. completed_at - started_at is a labelled FALLBACK so old
  // visits still show something. The two are different claims and never
  // silently swap: the label says which one you are looking at.
  const measuredMs =
    visit.on_site_first_at && visit.on_site_last_at
      ? Math.max(0, new Date(visit.on_site_last_at).getTime() - new Date(visit.on_site_first_at).getTime())
      : null;
  const measuredMinutes = measuredMs !== null ? Math.round(measuredMs / 60000) : null;
  const phonesOnSite = visit.on_site_user_ids?.length ?? 0;

  // Status-coupled fallback — "Start to done", only when there is no measured window.
  const onSiteMinutes =
    measuredMinutes === null && visit.started_at && visit.completed_at
      ? Math.max(
          0,
          Math.round(
            (new Date(visit.completed_at).getTime() -
              new Date(visit.started_at).getTime()) /
              60000
          )
        )
      : null;

  // Man-hours: measured duration × the shift's recorded crew size. Shown ONLY
  // when the join above actually found a shift with a crew_size — if the
  // multiplier is unknown it must LOOK unknown (null), never default to 1.
  const manHoursOnSite =
    measuredMs !== null && measuredMs > 0 && crewSize !== null
      ? manHours(measuredMs, crewSize)
      : null;

  // Measurement flag — phrased as missing measurement context, never as crew
  // fault: too_long/too_short most often mean we lack a lot size.
  const MEASUREMENT_FLAG_LABEL: Record<string, string> = {
    too_long: "Longer than the expected range",
    too_short: "Shorter than the expected range",
    no_departure: "No departure recorded",
  };
  const flagLabel = visit.measurement_flag
    ? MEASUREMENT_FLAG_LABEL[visit.measurement_flag] ?? visit.measurement_flag
    : null;

  // Start is a one-way stamp and only makes sense on work not yet finished.
  const canStart = !visit.started_at && status === "pending";

  const canMarkDone = nextStatuses.includes("done");
  const canSkip = isOffice && nextStatuses.includes("skipped");
  const canReopen = isOffice && nextStatuses.includes("pending");

  return (
    <PageContainer title={jobName} backHref={ isOffice ? `/lawn/schedules/${visit.recurring_schedule_id}` : "/lawn/my-route" } backLabel={isOffice ? "Schedule" : "Route"} maxWidth="list">
      <HighlightsHeader
        title={jobName}
        subtitle={custName ?? undefined}
        status={{
          label: LAWN_VISIT_STATUS_LABEL[status] ?? visit.status,
          tone: LAWN_VISIT_STATUS_TONE[status] ?? "neutral",
        }}
        accent={LAWN_VISIT_STATUS_TONE[status] ?? "brand"}
        fields={[
          {
            label: "Due",
            value: windowLabel ? `${visit.due_date} · ${windowLabel}` : visit.due_date,
          },
          { label: "Address", value: jobAddress ?? "—" },
          {
            label: "Est. time",
            value: effectiveDuration === null ? "—" : `${effectiveDuration} min`,
          },
          {
            // Label carries the claim: measured geofence window vs the
            // status-coupled start-to-done fallback. Never silently swap.
            label:
              measuredMinutes !== null
                ? "On site (measured)"
                : onSiteMinutes !== null
                ? "Start to done"
                : "Completed",
            value:
              measuredMinutes !== null
                ? `${measuredMinutes} min${phonesOnSite > 1 ? ` · ${phonesOnSite} phones` : ""}`
                : onSiteMinutes !== null
                ? `${onSiteMinutes} min`
                : visit.completed_at
                ? new Date(visit.completed_at).toLocaleDateString()
                : "—",
          },
        ]}
      />

      <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
        {status === "skipped" && visit.skip_reason && (
          <p className="text-xs text-gray-500">
            Skipped · {visit.skip_reason}
          </p>
        )}

        {/* Status actions — which ones render is the lifecycle's call now. */}
        {showSkipPicker ? (
          <SkipReasonPicker
            busy={busy}
            onConfirm={(reason) => updateStatus("skipped", reason)}
            onCancel={() => setShowSkipPicker(false)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 pt-1">
            {canStart && (
              <Button type="button" onClick={startVisit} disabled={starting || busy}>
                {starting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Start
              </Button>
            )}
            {canMarkDone && (
              <Button type="button" onClick={() => updateStatus("done")} disabled={busy}>
                <Check className="w-4 h-4" />
                Mark done
              </Button>
            )}
            {canSkip && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowSkipPicker(true)}
                disabled={busy}
              >
                <X className="w-4 h-4" />
                Skip
              </Button>
            )}
            {canReopen && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => updateStatus("pending")}
                disabled={busy}
              >
                <RotateCcw className="w-4 h-4" />
                Reopen
              </Button>
            )}
          </div>
        )}

        {visit.started_at && (
          <p className="text-xs text-gray-500">
            Started {new Date(visit.started_at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            {onSiteMinutes !== null && ` · start to done ${onSiteMinutes} min`}
          </p>
        )}

        {/* On-site measurement — the geofence window, its man-hour figure, and
            the flag state. Fallback (started/completed) is labelled above; this
            card exists only when the measurement exists or was flagged. */}
        {(measuredMinutes !== null || visit.measurement_flag) && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 space-y-1">
            {measuredMinutes !== null ? (
              <p>
                <span className="font-medium text-gray-700">Measured on site:</span>{" "}
                {measuredMinutes} min
                {phonesOnSite > 1
                  ? ` · ${phonesOnSite} phones on site`
                  : ` · ${phonesOnSite} phone${phonesOnSite === 1 ? "" : "s"}`}
              </p>
            ) : (
              visit.on_site_first_at && (
                <p>
                  <span className="font-medium text-gray-700">Measured on site:</span>{" "}
                  arrived{" "}
                  {new Date(visit.on_site_first_at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}{" "}
                  — no departure recorded yet
                </p>
              )
            )}
            {manHoursOnSite !== null ? (
              <p>
                <span className="font-medium text-gray-700">Man-hours:</span>{" "}
                {manHoursOnSite.toFixed(2)} ({crewSize} crew × {measuredMinutes} min)
              </p>
            ) : (
              measuredMinutes !== null && (
                <p>
                  <span className="font-medium text-gray-700">Man-hours:</span> not
                  shown — the shift covering this visit has no crew size recorded
                  on it.
                </p>
              )
            )}
            {flagLabel && (
              <p className="text-gray-500">
                Measurement flagged ({flagLabel}) — not used for pricing. This
                usually means the property&apos;s lot size is missing, not that
                the visit went wrong.
              </p>
            )}
          </div>
        )}

        {/* Appointment window — office/PM only (a window is a scheduling
            decision, same audience as Skip/Reopen/Move above). NOTE: the
            window columns live on lawn_visits, so this is per-visit; there is
            no schedule-level window column to inherit from. */}
        {isOffice &&
          (editingWindow ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              />
              <span className="text-xs text-gray-400">to</span>
              <input
                type="time"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              />
              <Button
                type="button"
                size="sm"
                onClick={saveWindow}
                disabled={savingWindow}
              >
                {savingWindow && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setEditingWindow(false)}
                disabled={savingWindow}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={openWindowEditor}
              className="text-xs text-blue-600 font-medium"
            >
              {windowLabel ? `Window: ${windowLabel} — edit` : "Set arrival window"}
            </button>
          ))}

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
        {/* Three buttons rather than one, because the tag has to be chosen
            BEFORE the camera opens. Asking afterwards means asking a crew
            member holding a trimmer to sort a batch, which is how a field app
            ends up with no tagged photos at all. "Other" stays available for a
            gate code or a broken sprinkler head, which is neither. */}
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => { pendingPhase.current = "before"; fileRef.current?.click(); }}
            className="bg-amber-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-amber-700 flex items-center justify-center gap-1.5"
          >
            <Camera className="w-4 h-4" />
            Before
          </button>
          <button
            type="button"
            onClick={() => { pendingPhase.current = "after"; fileRef.current?.click(); }}
            className="bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 flex items-center justify-center gap-1.5"
          >
            <Camera className="w-4 h-4" />
            After
          </button>
          <button
            type="button"
            onClick={() => { pendingPhase.current = null; fileRef.current?.click(); }}
            className="bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-1.5"
          >
            <Camera className="w-4 h-4" />
            Other
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            onChange={(e) => handleFiles(e.target.files, pendingPhase.current)}
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
          href={`/lawn/schedules/${visit.recurring_schedule_id}`}
          className="block text-center text-sm text-blue-600 font-medium py-2"
        >
          Open schedule →
        </Link>
      )}
    </PageContainer>
  );
}
