import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { fetchJobScheduleReport } from "@/lib/jobScheduleReport";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "office" && profile?.role !== "admin")
    return NextResponse.json({ error: "Office only" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("job") || "";
  if (!jobId) return NextResponse.json({ error: "Missing job" }, { status: 400 });

  const rows = await fetchJobScheduleReport(supabase, jobId);
  const aoa: (string | number)[][] = [
    ["Position", "Title", "Kind", "Cost Code", "Start", "End", "Days", "% Complete", "Predecessors", "Assigned To", "Critical"],
  ];
  for (const r of rows) {
    aoa.push([
      r.position,
      r.title,
      r.kind,
      r.cost_code ?? "",
      r.start_date ? new Date(`${r.start_date}T00:00:00`).toLocaleDateString() : "",
      r.end_date ? new Date(`${r.end_date}T00:00:00`).toLocaleDateString() : "",
      r.days,
      r.percent_complete,
      r.predecessors,
      r.assignee_name ?? "",
      r.critical,
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Schedule");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="job-schedule-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}