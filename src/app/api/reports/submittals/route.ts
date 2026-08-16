import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { fetchSubmittalsReport } from "@/lib/gcReports";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error:"Not signed in" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "office" && profile?.role !== "admin") return NextResponse.json({ error:"Office only" }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const filters = { jobId: searchParams.get("job") || null, status: searchParams.get("status") || null };
  const rows = await fetchSubmittalsReport(supabase, filters);
  const aoa: (string|number)[][] = [["Submittal No","Title","Job","CSI Section","Status","Disposition","Ball In Court","Created"]];
  for (const r of rows) aoa.push([
    r.submittal_number ?? "-", r.title, r.job_name ?? "-", r.csi_section ?? "", r.status,
    r.disposition ? r.disposition.replace(/_/g," ") : "", r.ball_in_court, new Date(r.created_at).toLocaleDateString()
  ]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Submittals");
  const buf = XLSX.write(wb, { type:"array", bookType:"xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const stamp = new Date().toISOString().slice(0,10);
  return new NextResponse(blob, { status:200, headers:{ "Content-Disposition":`attachment; filename="submittals-${stamp}.xlsx"`, "Cache-Control":"no-store" } });
}