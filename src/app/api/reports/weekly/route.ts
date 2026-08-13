import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { parseWeekStart, addDays, hoursFromMs } from "@/lib/weekUtils";

// Weekly per-worker report — office only. Streams a real .xlsx workbook with
// Summary / Timesheet / Photos / Receipts sheets for the selected Monday-based
// week. Office RLS lets us read all time_entries, photos, receipts, and
// profiles directly (no service role needed).

type Profile = { id: string; full_name: string | null; role: string | null };

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "office" && profile?.role !== "admin") {
    return NextResponse.json({ error: "Office only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const weekStart = parseWeekStart(searchParams.get("weekStart") ?? undefined);
  const weekEnd = addDays(weekStart, 7);
  const startISO = weekStart.toISOString();
  const endISO = weekEnd.toISOString();
  const now = Date.now();

  const [timeRes, photoRes, receiptRes, profileRes] = await Promise.all([
    supabase
      .from("time_entries")
      .select(
        "user_id, clock_in_at, clock_out_at, note, job:jobs(name), cost_code:cost_codes(code, name)"
      )
      .gte("clock_in_at", startISO)
      .lt("clock_in_at", endISO)
      .order("clock_in_at", { ascending: true }),
    supabase
      .from("photos")
      .select("uploaded_by, created_at, caption, lat, lng, job:jobs(name)")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: true }),
    supabase
      .from("receipts")
      .select(
        "uploaded_by, uploaded_by_name, captured_at, vendor, amount, tax, category, reimbursed, notes, job:jobs(name)"
      )
      .gte("captured_at", startISO)
      .lt("captured_at", endISO)
      .order("captured_at", { ascending: true }),
    supabase.from("profiles").select("id, full_name, role").order("full_name"),
  ]);

  const profiles = new Map<string, Profile>();
  for (const p of (profileRes.data ?? []) as Profile[]) {
    profiles.set(p.id, p);
  }
  const nameOf = (id: string | null, fallback?: string | null) =>
    (id && profiles.get(id)?.full_name) || fallback || "Unknown";
  const roleOf = (id: string | null) => profiles.get(id ?? "")?.role ?? "—";

  type TimeRow = {
    user_id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    note: string | null;
    job: { name: string | null } | null;
    cost_code: { code: string; name: string } | null;
  };
  type PhotoRow = {
    uploaded_by: string | null;
    created_at: string;
    caption: string | null;
    lat: number | null;
    lng: number | null;
    job: { name: string | null } | null;
  };
  type ReceiptRow = {
    uploaded_by: string | null;
    uploaded_by_name: string | null;
    captured_at: string;
    vendor: string | null;
    amount: number | null;
    tax: number | null;
    category: string | null;
    reimbursed: boolean | null;
    notes: string | null;
    job: { name: string | null } | null;
  };

  const times = (timeRes.data ?? []) as unknown as TimeRow[];
  const photos = (photoRes.data ?? []) as unknown as PhotoRow[];
  const receipts = (receiptRes.data ?? []) as unknown as ReceiptRow[];

  // Per-worker aggregates keyed by user id.
  const workers = new Map<
    string,
    {
      hours: number;
      projects: Set<string>;
      photos: number;
      submitted: number;
      paidBack: number;
      owed: number;
    }
  >();
  function ensureWorker(id: string) {
    if (!workers.has(id)) {
      workers.set(id, {
        hours: 0,
        projects: new Set(),
        photos: 0,
        submitted: 0,
        paidBack: 0,
        owed: 0,
      });
    }
    return workers.get(id)!;
  }

  const timesheetRows: (string | number)[][] = [];
  for (const t of times) {
    const end = t.clock_out_at ? new Date(t.clock_out_at).getTime() : now;
    const hours = hoursFromMs(end - new Date(t.clock_in_at).getTime());
    const jobName = t.job?.name ?? "—";
    const cc = t.cost_code ? `${t.cost_code.code} ${t.cost_code.name}` : "";
    const w = ensureWorker(t.user_id);
    w.hours += hours;
    if (jobName !== "—") w.projects.add(jobName);
    timesheetRows.push([
      nameOf(t.user_id),
      jobName,
      new Date(t.clock_in_at).toLocaleDateString(),
      new Date(t.clock_in_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      t.clock_out_at
        ? new Date(t.clock_out_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—",
      hours,
      cc,
      t.note ?? "",
    ]);
  }

  const photoRows: (string | number)[][] = [];
  for (const p of photos) {
    const jobName = p.job?.name ?? "—";
    if (p.uploaded_by) {
      const w = ensureWorker(p.uploaded_by);
      w.photos += 1;
      if (jobName !== "—") w.projects.add(jobName);
    }
    photoRows.push([
      nameOf(p.uploaded_by),
      jobName,
      new Date(p.created_at).toLocaleDateString(),
      p.caption ?? "",
      p.lat ?? "",
      p.lng ?? "",
    ]);
  }

  const receiptRows: (string | number)[][] = [];
  for (const r of receipts) {
    const jobName = r.job?.name ?? "—";
    const amount = Number(r.amount ?? 0);
    if (r.uploaded_by) {
      const w = ensureWorker(r.uploaded_by);
      w.submitted += amount;
      if (r.reimbursed) w.paidBack += amount;
      else w.owed += amount;
      if (jobName !== "—") w.projects.add(jobName);
    }
    receiptRows.push([
      nameOf(r.uploaded_by, r.uploaded_by_name),
      jobName,
      new Date(r.captured_at).toLocaleDateString(),
      r.vendor ?? "",
      amount,
      Number(r.tax ?? 0),
      r.category ?? "",
      r.reimbursed ? "Yes" : "No",
      r.notes ?? "",
    ]);
  }

  // ── Build the workbook ───────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  const summaryAoA: (string | number)[][] = [
    [
      "Worker",
      "Role",
      "Total Hours",
      "# Projects",
      "# Photos",
      "Receipts Submitted $",
      "Paid Back $",
      "Owed $",
    ],
  ];
  const workerIds = [...workers.keys()].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b))
  );
  for (const id of workerIds) {
    const w = workers.get(id)!;
    summaryAoA.push([
      nameOf(id),
      roleOf(id),
      w.hours,
      w.projects.size,
      w.photos,
      w.submitted,
      w.paidBack,
      w.owed,
    ]);
  }
  // Totals row.
  summaryAoA.push([
    "TOTAL",
    "",
    workerIds.reduce((s, id) => s + (workers.get(id)?.hours ?? 0), 0),
    "",
    workerIds.reduce((s, id) => s + (workers.get(id)?.photos ?? 0), 0),
    workerIds.reduce((s, id) => s + (workers.get(id)?.submitted ?? 0), 0),
    workerIds.reduce((s, id) => s + (workers.get(id)?.paidBack ?? 0), 0),
    workerIds.reduce((s, id) => s + (workers.get(id)?.owed ?? 0), 0),
  ]);

  const summary = XLSX.utils.aoa_to_sheet(summaryAoA);
  XLSX.utils.book_append_sheet(wb, summary, "Summary");

  const timesheet = XLSX.utils.aoa_to_sheet([
    ["Worker", "Job", "Date", "Clock In", "Clock Out", "Hours", "Cost Code", "Note"],
    ...timesheetRows,
  ]);
  XLSX.utils.book_append_sheet(wb, timesheet, "Timesheet");

  const photoSheet = XLSX.utils.aoa_to_sheet([
    ["Worker", "Job", "Date", "Caption", "Lat", "Lng"],
    ...photoRows,
  ]);
  XLSX.utils.book_append_sheet(wb, photoSheet, "Photos");

  const receiptSheet = XLSX.utils.aoa_to_sheet([
    [
      "Worker",
      "Job",
      "Date",
      "Vendor",
      "Amount $",
      "Tax $",
      "Category",
      "Paid Back",
      "Notes",
    ],
    ...receiptRows,
  ]);
  XLSX.utils.book_append_sheet(wb, receiptSheet, "Receipts");

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const fileDate = weekStart.toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="weekly-report-${fileDate}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}