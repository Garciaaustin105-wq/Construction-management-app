import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { fetchChangeOrdersReport } from "@/lib/gcReports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "office" && profile?.role !== "admin")
    return NextResponse.json({ error: "Office only" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const filters = {
    jobId: searchParams.get("job") || null,
    status: searchParams.get("status") || null,
  };

  const rows = await fetchChangeOrdersReport(supabase, filters);
  const aoa: (string | number)[][] = [
    ["CO Number", "Title", "Amount", "Credit", "Status", "Created", "Job"],
  ];

  for (const r of rows) {
    aoa.push([
      r.co_number ?? "",
      r.title,
      r.is_credit ? -r.amount : r.amount,
      r.is_credit ? "Yes" : "No",
      r.status,
      new Date(r.created_at).toLocaleDateString(),
      r.job_name ?? "-",
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "Change Orders");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="change-orders-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}