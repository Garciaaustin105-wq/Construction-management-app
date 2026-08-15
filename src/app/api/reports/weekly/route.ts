import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { addDays, hoursFromMs, toISODate } from "@/lib/weekUtils";
import { resolveReportRange, rangeDayCount } from "@/lib/reports";

// Per-Worker report (formerly "weekly") — office only. Streams a real .xlsx
// workbook for a selectable date range + job/worker/cost-code filters with the
// following sheets:
//   1. Summary           — per-worker totals + "Paid This Week $" + Projects
//   2. Daily Hours        — one column per day in the range × worker hours grid
//                           (omitted when the range exceeds 31 days)
//   3. Hours by Code      — hours per worker × cost code
//   4. Timesheet          — every clock-in row (with GPS lat/lng/source)
//   5. Receipts           — every receipt captured in range (with payment
//                           method, receipt no, reimbursed_at)
//   6. Payments           — receipts *paid* in range (reimbursed_at in range),
//                           including ones captured in a prior range
//   7..N. <Worker>        — one detail sheet per worker (their timesheet +
//                           receipts stacked on one tab)
//
// Photos are intentionally excluded from this report (per user request). Office
// RLS lets us read all time_entries, receipts, and profiles directly (no service
// role needed). Tenant scoping is RLS-enforced — the route uses the user-scoped
// server client, never the service role.

type Profile = { id: string; full_name: string | null; role: string | null };

// Sheet tab names can't contain any of these chars, can't exceed 31 chars, and
// can't repeat. Sanitize a worker's display name into a valid, unique tab name.
function sheetNameOf(name: string, used: Set<string>): string {
  const cleaned = name
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
  const base = cleaned || "Worker";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = ` ${n}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

// Location-source label for GPS columns — "gps"/"ip" or "—" when unknown.
function locLabel(src: string | null | undefined): string {
  return src ?? "—";
}

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

  const allowedRoles: Record<string, boolean> = { office: true, admin: true };
  if (!allowedRoles[profile?.role ?? ""]) {
    return NextResponse.json({ error: "Office only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("job") || null;
  const workerId = searchParams.get("worker") || null;
  const codeId = searchParams.get("code") || null;
  const { from, toInclusive } = resolveReportRange(
    searchParams.get("from"),
    searchParams.get("to"),
    searchParams.get("weekStart") // legacy fallback
  );
  );
  const dayCount = rangeDayCount(from, toInclusive);
  const showDaily = dayCount <= 31;

  const startISO = from.toISOString();
  const endISO = addDays(toInclusive, 1).toISOString(); // exclusive end
  const now = Date.now();
  // Local-midnight of the range start — used to bucket each clock-in into a
  // day column (0 = first day … dayCount-1 = last). DST-safe via Math.round.
  const fromLocalMs = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate()
  ).getTime();

  // Apply the shared filters to a query. `userCol` differs per table
  // (time_entries.user_id vs receipts.uploaded_by).
  function applyFilters<T>(q: T, userCol: string): T {
    let qq = q as unknown as { eq: (c: string, v: string) => unknown };
    if (jobId) qq = qq.eq("job_id", jobId) as typeof qq;
    if (workerId) qq = qq.eq(userCol, workerId) as typeof qq;
    if (codeId) qq = qq.eq("cost_code_id", codeId) as typeof qq;
    return qq as unknown as T;
  }

  const [timeRes, receiptRes, paymentRes, profileRes] = await Promise.all([
    applyFilters(
      supabase
        .from("time_entries")
        .select(
          "user_id, clock_in_at, clock_out_at, note, lat, lng, location_source, job:jobs(name), cost_code:cost_codes(code, name)"
        )
        .gte("clock_in_at", startISO)
        .lt("clock_in_at", endISO)
        .order("clock_in_at", { ascending: true }),
      "user_id"
    ),
    applyFilters(
      supabase
        .from("receipts")
        .select(
          "uploaded_by, uploaded_by_name, captured_at, vendor, amount, tax, category, payment_method, receipt_no, reimbursed, reimbursed_at, notes, job:jobs(name)"
        )
        .gte("captured_at", startISO)
        .lt("captured_at", endISO)
        .order("captured_at", { ascending: true }),
      "uploaded_by"
    ),
    // Receipts *paid* in range (reimbursed_at in range) — catches payments
    // processed in range for receipts captured in a prior range. The detail
    // Receipts sheet above is filtered on captured_at and would miss these.
    applyFilters(
      supabase
        .from("receipts")
        .select(
          "uploaded_by, uploaded_by_name, amount, vendor, captured_at, reimbursed_at, job:jobs(name)"
        )
        .eq("reimbursed", true)
        .gte("reimbursed_at", startISO)
        .lt("reimbursed_at", endISO)
        .order("reimbursed_at", { ascending: true }),
      "uploaded_by"
    ),
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
    lat: number | null;
    lng: number | null;
    location_source: string | null;
    job: { name: string | null } | null;
    cost_code: { code: string; name: string } | null;
  };
  type ReceiptRow = {
    uploaded_by: string | null;
    uploaded_by_name: string | null;
    captured_at: string;
    vendor: string | null;
    amount: number | null;
    tax: number | null;
    category: string | null;
    payment_method: string | null;
    receipt_no: string | null;
    reimbursed: boolean | null;
    reimbursed_at: string | null;
    notes: string | null;
    job: { name: string | null } | null;
  };
  type PaymentRow = {
    uploaded_by: string | null;
    uploaded_by_name: string | null;
    amount: number | null;
    vendor: string | null;
    captured_at: string;
    reimbursed_at: string;
    job: { name: string | null } | null;
  };

  const times = (timeRes.data ?? []) as unknown as TimeRow[];
  const receipts = (receiptRes.data ?? []) as unknown as ReceiptRow[];
  const payments = (paymentRes.data ?? []) as unknown as PaymentRow[];

  // Per-worker aggregates keyed by user id.
  type WorkerAgg = {
    hours: number;
    projects: Set<string>;
    submitted: number;
    paidBack: number;
    owed: number;
    paidThisWeek: number;
    hoursByDay: number[]; // length dayCount, index 0 = first day
    hoursByCode: Map<string, number>; // key = "code name" | "— No code —"
  };
  const workers = new Map<string, WorkerAgg>();
  function ensureWorker(id: string): WorkerAgg {
    let w = workers.get(id);
    if (!w) {
      w = {
        hours: 0,
        projects: new Set(),
        submitted: 0,
        paidBack: 0,
        owed: 0,
        paidThisWeek: 0,
        hoursByDay: Array.from({ length: dayCount }, () => 0),
        hoursByCode: new Map(),
      };
      workers.set(id, w);
    }
    return w;
  }

  const timesheetRows: (string | number)[][] = [];
  for (const t of times) {
    const end = t.clock_out_at ? new Date(t.clock_out_at).getTime() : now;
    const hours = hoursFromMs(end - new Date(t.clock_in_at).getTime());
    const jobName = t.job?.name ?? "—";
    const cc = t.cost_code ? `${t.cost_code.code} ${t.cost_code.name}` : "— No code —";
    const w = ensureWorker(t.user_id);
    w.hours += hours;
    if (jobName !== "—") w.projects.add(jobName);
    w.hoursByCode.set(cc, (w.hoursByCode.get(cc) ?? 0) + hours);
    // Bucket the shift into the day of its clock-in date. A shift spanning
    // midnight attributes all its hours to the clock-in day — simple and
    // consistent with the per-shift rounding above.
    const ci = new Date(t.clock_in_at);
    const ciLocalMs = new Date(
      ci.getFullYear(),
      ci.getMonth(),
      ci.getDate()
    ).getTime();
    const dayIdx = Math.min(
      dayCount - 1,
      Math.max(0, Math.round((ciLocalMs - fromLocalMs) / 86_400_000))
    );
    w.hoursByDay[dayIdx] += hours;
    timesheetRows.push([
      nameOf(t.user_id),
      jobName,
      ci.toLocaleDateString(),
      ci.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      t.clock_out_at
        ? new Date(t.clock_out_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—",
      hours,
      cc,
      t.lat ?? "",
      t.lng ?? "",
      locLabel(t.location_source),
      t.note ?? "",
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
      r.payment_method ?? "—",
      r.receipt_no ?? "—",
      r.reimbursed ? "Yes" : "No",
      r.reimbursed_at ? new Date(r.reimbursed_at).toLocaleDateString() : "—",
      r.notes ?? "",
    ]);
  }

  const paymentRows: (string | number)[][] = [];
  for (const pmt of payments) {
    const amount = Number(pmt.amount ?? 0);
    if (pmt.uploaded_by) {
      const w = ensureWorker(pmt.uploaded_by);
      w.paidThisWeek += amount;
    }
    paymentRows.push([
      nameOf(pmt.uploaded_by, pmt.uploaded_by_name),
      pmt.job?.name ?? "—",
      pmt.vendor ?? "",
      amount,
      new Date(pmt.captured_at).toLocaleDateString(),
      new Date(pmt.reimbursed_at).toLocaleDateString(),
    ]);
  }

  // ── Build the workbook ───────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  const usedSheetNames = new Set<string>();

  const workerIds = [...workers.keys()].sort((idA, idB) =>
    nameOf(idA).localeCompare(nameOf(idB))
  );

  // 1. Summary — "Projects" lists the comma-joined project names per worker.
  const summaryAoA: (string | number)[][] = [
    [
      "Worker",
      "Role",
      "Total Hours",
      "Projects",
      "Receipts Submitted $",
      "Paid Back $",
      "Owed $",
      "Paid This Week $",
    ],
  ];
  for (const id of workerIds) {
    const worker = workers.get(id);
    summaryAoA.push([
      nameOf(id),
      roleOf(id),
      worker?.hours ?? 0,
      worker?.projects ? [...worker.projects].sort().join(", ") : "",
      worker?.submitted ?? 0,
      worker?.paidBack ?? 0,
      worker?.owed ?? 0,
      worker?.paidThisWeek ?? 0,
    ]);
  }
  summaryAoA.push([
    "TOTAL",
    "",
    workerIds.reduce((sum, id) => sum + (workers.get(id)?.hours ?? 0), 0),
    "",
    workerIds.reduce((sum, id) => sum + (workers.get(id)?.submitted ?? 0), 0),
    workerIds.reduce((sum, id) => sum + (workers.get(id)?.paidBack ?? 0), 0),
    workerIds.reduce((sum, id) => sum + (workers.get(id)?.owed ?? 0), 0),
    workerIds.reduce((sum, id) => sum + (workers.get(id)?.paidThisWeek ?? 0), 0),
  ]);
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(summaryAoA),
    "Summary"
  );

  // 2. Daily Hours — one column per day in the range × worker grid + total.
  // Omitted when the range exceeds 31 days (the grid would be unwieldy).
  if (showDaily) {
    const dayHeaders = Array.from({ length: dayCount }, (_, i) => {
      const date = addDays(from, i);
      return date.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
    });
    const dailyAoA: (string | number)[][] = [
      ["Worker", ...dayHeaders, "Total"],
    ];
    for (const id of workerIds) {
      const worker = workers.get(id);
      dailyAoA.push([
        nameOf(id),
        ...(worker?.hoursByDay ?? []),
        (worker?.hoursByDay ?? []).reduce((sum, hours) => sum + hours, 0),
      ]);
    }
    const dailyTotals = Array.from({ length: dayCount }, (_, i) =>
      workerIds.reduce(
        (total, id) => total + (workers.get(id)?.hoursByDay[i] ?? 0),
        0
      )
    );
    dailyAoA.push([
      "TOTAL",
      ...dailyTotals,
      dailyTotals.reduce((sum, hours) => sum + hours, 0),
    ]);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(dailyAoA),
      "Daily Hours"
    );
  }

  // 3. Hours by Code — one row per (worker × cost code) with nonzero hours.
  const byCodeAoA: (string | number)[][] = [["Worker", "Cost Code", "Hours"]];
  let byCodeTotal = 0;
  for (const id of workerIds) {
    const worker = workers.get(id);
    const codes = [...(worker?.hoursByCode ?? new Map()).entries()].sort((entryA, entryB) =>
      entryA[0].localeCompare(entryB[0])
    );
    for (const [code, hrs] of codes) {
      byCodeAoA.push([nameOf(id), code, hrs]);
      byCodeTotal += hrs;
    }
  }
  byCodeAoA.push(["TOTAL", "", byCodeTotal]);
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(byCodeAoA),
    "Hours by Code"
  );

  // 4. Timesheet
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "Worker",
        "Job",
        "Date",
        "Clock In",
        "Clock Out",
        "Hours",
        "Cost Code",
        "Lat",
        "Lng",
        "Location",
        "Note",
      ],
      ...timesheetRows,
    ]),
    "Timesheet"
  );

  // 5. Receipts
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "Worker",
        "Job",
        "Date",
        "Vendor",
        "Amount $",
        "Tax $",
        "Category",
        "Payment Method",
        "Receipt No",
        "Paid Back",
        "Reimbursed At",
        "Notes",
      ],
      ...receiptRows,
    ]),
    "Receipts"
  );

  // 6. Payments (paid in range)
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "Worker",
        "Job",
        "Vendor",
        "Amount $",
        "Captured",
        "Reimbursed At",
      ],
      ...paymentRows,
      [
        "TOTAL",
        "",
        "",
        paymentRows.reduce((s, r) => s + (Number(r[3]) || 0), 0),
        "",
        "",
      ],
    ]),
    "Payments"
  );

  // 7..N. Per-worker detail sheets — one tab per worker with their timesheet +
  // receipts stacked. Rows are filtered by user id (NOT by display name) so
  // two workers who share a name — or who both fall back to "Unknown" — don't
  // get merged. Sheet names are sanitized + deduped.
  for (const id of workerIds) {
    const name = nameOf(id);
    const role = roleOf(id);
    const sheet: (string | number)[][] = [[`${name} — ${role}`]];

    sheet.push(["Timesheet"]);
    sheet.push([
      "Job",
      "Date",
      "In",
      "Out",
      "Hours",
      "Cost Code",
      "Lat",
      "Lng",
      "Location",
      "Note",
    ]);
    for (const t of times) {
      if (t.user_id !== id) continue;
      const end = t.clock_out_at ? new Date(t.clock_out_at).getTime() : now;
      sheet.push([
        t.job?.name ?? "—",
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
        hoursFromMs(end - new Date(t.clock_in_at).getTime()),
        t.cost_code ? `${t.cost_code.code} ${t.cost_code.name}` : "— No code —",
        t.lat ?? "",
        t.lng ?? "",
        locLabel(t.location_source),
        t.note ?? "",
      ]);
    }

    sheet.push([]);
    sheet.push(["Receipts"]);
    sheet.push([
      "Job",
      "Date",
      "Vendor",
      "Amount $",
      "Tax $",
      "Category",
      "Pay Method",
      "Receipt No",
      "Paid Back",
      "Reimbursed At",
      "Notes",
    ]);
    for (const r of receipts) {
      if (r.uploaded_by !== id) continue;
      sheet.push([
        r.job?.name ?? "—",
        new Date(r.captured_at).toLocaleDateString(),
        r.vendor ?? "",
        Number(r.amount ?? 0),
        Number(r.tax ?? 0),
        r.category ?? "",
        r.payment_method ?? "—",
        r.receipt_no ?? "—",
        r.reimbursed ? "Yes" : "No",
        r.reimbursed_at ? new Date(r.reimbursed_at).toLocaleDateString() : "—",
        r.notes ?? "",
      ]);
    }

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(sheet),
      sheetNameOf(name, usedSheetNames)
    );
  }

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const fileStamp = `${toISODate(from)}_to_${toISODate(toInclusive)}`;
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="per-worker-report-${fileStamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}