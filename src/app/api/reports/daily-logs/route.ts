import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { fetchDailyLogsReport } from "@/lib/gcReports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "office" && profile?.role !== "admin") return NextResponse.json({ error: "Office only" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const filters = {
    jobId: searchParams.get("job") || null,
    from: searchParams.get("from") || null,
    to: searchParams.get("to") || null
  };

  const rows = await fetchDailyLogsReport(supabase, filters);
  const aoa: (string | number)[][] = [
    ["Date", "Job", "Author", "Weather", "Work Performed", "Equipment", "Materials", "Delays", "Safety Notes", "Crew Count", "Status"]
  ];

  for (const r of rows) {
    aoa.push([
      new Date(r.log_date).toLocaleDateString(),
      r.job_name ?? "-",
      r.author_name ?? "-",
      r.weather ?? "",
      r.work_performed ?? "",
      r.equipment ?? "",
      r.materials ?? "",
      r.delays ?? "",
      r.safety_notes ?? "",
      r.crew_count ?? "",
      r.status
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Daily Logs");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="daily-logs-${stamp}.xlsx"`,
      "Cache-Control": "no-store"
    }
  });
}