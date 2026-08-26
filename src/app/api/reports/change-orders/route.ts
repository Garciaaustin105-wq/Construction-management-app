import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { fetchChangeOrdersReport } from "@/lib/gcReports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const XLSX = await import("xlsx");
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
    [
      "CO Number",
      "Title",
      "Amount",
      "Credit",
      "Status",
      "Created",
      "Job",
      "Approved By",
      "Approval Method",
      "Approved At",
    ],
  ];

  // Issue 5: visible attribution in the export. method is null on historical
  // rows (rendered "legacy") — the whole point is to discourage casual approvals
  // by naming who clicked approve and how.
  const methodLabel = (m: string | null): string =>
    m === "manual_office"
      ? "Manual (office)"
      : m === "customer_portal"
        ? "Customer portal"
        : m === "email"
          ? "Email"
          : "legacy";

  for (const r of rows) {
    aoa.push([
      r.co_number ?? "",
      r.title,
      r.is_credit ? -r.amount : r.amount,
      r.is_credit ? "Yes" : "No",
      r.status,
      new Date(r.created_at).toLocaleDateString(),
      r.job_name ?? "-",
      r.approver_name ?? "-",
      methodLabel(r.approval_method),
      r.approved_at ? new Date(r.approved_at).toLocaleString() : "-",
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