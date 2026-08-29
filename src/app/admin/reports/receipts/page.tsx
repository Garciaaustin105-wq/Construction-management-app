import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import ReceiptReportFilters from "@/components/ReceiptReportFilters";
import { fetchReceiptsReport, receiptTotals, type ReceiptReportFilters as Filters } from "@/lib/reports";
import { signedThumbnail } from "@/lib/storage";
import { formatMoney } from "@/lib/money";
import ReceiptReportPaidToggle from "@/components/ReceiptReportPaidToggle";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office-only receipts report. On-screen itemized table (one row per receipt)
// with the receipt photo thumbnail + a per-row download, filterable by job /
// worker / cost code / date range, with Excel + PDF export. Mirrors the weekly
// report's office/admin gate. RLS scopes every query to the caller's org.
export default async function ReceiptsReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    job?: string;
    worker?: string;
    code?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  if (!OFFICE_OR_PM.has((me.role) as never)) redirect("/dashboard");

  const sp = await searchParams;
  const filters: Filters = {
    jobId: sp.job || null,
    workerId: sp.worker || null,
    costCodeId: sp.code || null,
    from: sp.from || null,
    to: sp.to || null,
  };

  // Dropdown data + the filtered receipts in parallel.
  const [jobsRes, workersRes, codesRes, rows] = await Promise.all([
    supabase.from("jobs").select("id, name").eq("type", "construction").order("name"),
    supabase
      .from("profiles")
      .select("id, full_name")
      .order("full_name"),
    supabase.from("cost_codes").select("id, code, name").order("code"),
    fetchReceiptsReport(supabase, filters, { limit: 100 }),
  ]);

  const jobs = (jobsRes.data ?? []) as { id: string; name: string }[];
  const workers = ((workersRes.data ?? []) as { id: string; full_name: string | null }[]).map(
    (p) => ({ id: p.id, name: p.full_name ?? "Unknown" })
  );
  const costCodes = ((codesRes.data ?? []) as { id: string; code: string; name: string }[]).map(
    (c) => ({ id: c.id, label: `${c.code} · ${c.name}` })
  );

  // Mint signed URLs (1h) for the per-row download (full-res, batched — one
  // request) AND transformed 128px thumbnails for the on-screen table cells
  // (per-path singular, since createSignedUrls doesn't support `transform`).
  // The receipts bucket is private; office storage RLS allows reads.
  const paths = [...new Set(rows.map((r) => r.storage_path))];
  const urlByPath = new Map<string, string>();
  const thumbByPath = new Map<string, string>();
  if (paths.length > 0) {
    const [signed, thumbs] = await Promise.all([
      supabase.storage.from("receipts").createSignedUrls(paths, 3600),
      Promise.all(paths.map((p) => signedThumbnail(supabase, "receipts", p, 128))),
    ]);
    for (const s of signed.data ?? []) {
      if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
    }
    paths.forEach((p, i) => {
      if (thumbs[i]) thumbByPath.set(p, thumbs[i] as string);
    });
  }

  const totals = receiptTotals(rows);

  // Rebuild the filter query string for the export links.
  const exportQs = new URLSearchParams();
  if (filters.jobId) exportQs.set("job", filters.jobId);
  if (filters.workerId) exportQs.set("worker", filters.workerId);
  if (filters.costCodeId) exportQs.set("code", filters.costCodeId);
  if (filters.from) exportQs.set("from", filters.from);
  if (filters.to) exportQs.set("to", filters.to);
  const qs = exportQs.toString();

  return (
    <PageContainer title="Receipts Report" subtitle="Itemized expenses" maxWidth="list" backHref="/admin/reports" backLabel="Reports">
      {/* Filters */}
      <div className="bg-white rounded-lg p-3 shadow-sm">
        <ReceiptReportFilters
          jobs={jobs}
          workers={workers}
          costCodes={costCodes}
          current={{
            job: filters.jobId ?? "",
            worker: filters.workerId ?? "",
            code: filters.costCodeId ?? "",
            from: filters.from ?? "",
            to: filters.to ?? "",
          }}
        />
      </div>

      {/* Export buttons */}
      <div className="grid grid-cols-2 gap-2">
        <a
          href={`/api/reports/receipts${qs ? `?${qs}` : ""}`}
          download
          className="bg-green-600 text-white py-3 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2 text-sm"
        >
          <FileSpreadsheet className="w-4 h-4" />
          Excel
        </a>
        <a
          href={`/api/reports/receipts/pdf${qs ? `?${qs}` : ""}`}
          download
          className="bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2 text-sm"
        >
          <FileText className="w-4 h-4" />
          PDF
        </a>
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-white rounded-lg p-2 shadow-sm text-center">
          <p className="text-[10px] text-gray-500">Count</p>
          <p className="text-base font-bold text-gray-900">{totals.count}</p>
        </div>
        <div className="bg-white rounded-lg p-2 shadow-sm text-center">
          <p className="text-[10px] text-gray-500">Amount</p>
          <p className="text-base font-bold text-gray-900">{formatMoney(totals.amount)}</p>
        </div>
        <div className="bg-white rounded-lg p-2 shadow-sm text-center">
          <p className="text-[10px] text-gray-500">Owed</p>
          <p className="text-base font-bold text-amber-700">{formatMoney(totals.owed)}</p>
        </div>
        <div className="bg-white rounded-lg p-2 shadow-sm text-center">
          <p className="text-[10px] text-gray-500">Paid</p>
          <p className="text-base font-bold text-emerald-700">{formatMoney(totals.paid)}</p>
        </div>
      </div>

      {/* Itemized table */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Date</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">User</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Job</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Location</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Vendor</th>
                <th className="text-right font-semibold px-2 py-2 whitespace-nowrap">Amount</th>
                <th className="text-right font-semibold px-2 py-2 whitespace-nowrap">Tax</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Category</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Pay Method</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Receipt #</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Cost Code</th>
                <th className="text-left font-semibold px-2 py-2 whitespace-nowrap">Status</th>
                <th className="text-center font-semibold px-2 py-2 whitespace-nowrap">Photo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-2 py-8 text-center text-gray-500">
                    No receipts match these filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const url = urlByPath.get(r.storage_path);
                const thumb = thumbByPath.get(r.storage_path);
                const hasGps =
                  typeof r.lat === "number" && typeof r.lng === "number";
                return (
                  <tr key={r.id}>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {new Date(r.captured_at).toLocaleDateString()}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {r.uploaded_by_name ?? "—"}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.job_name ?? "—"}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {hasGps ? (
                        <a
                          href={`https://www.google.com/maps?q=${r.lat},${r.lng}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 underline"
                        >
                          {r.lat!.toFixed(4)}, {r.lng!.toFixed(4)}
                        </a>
                      ) : (
                        "—"
                      )}
                      {hasGps && r.location_source && (
                        <span className="text-gray-400 ml-1 lowercase">
                          {r.location_source}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.vendor ?? "—"}</td>
                    <td className="text-right px-2 py-2 tabular-nums whitespace-nowrap">
                      {formatMoney(Number(r.amount ?? 0))}
                    </td>
                    <td className="text-right px-2 py-2 tabular-nums whitespace-nowrap">
                      {r.tax != null ? formatMoney(Number(r.tax)) : "—"}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.category ?? "—"}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.payment_method ?? "—"}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.receipt_no ?? "—"}</td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      {r.cost_code_label ?? "—"}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <ReceiptReportPaidToggle
                        receiptId={r.id}
                        reimbursed={!!r.reimbursed}
                        reimbursedAt={r.reimbursed_at}
                      />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumb}
                            alt="Receipt"
                            loading="lazy"
                            decoding="async"
                            className="w-14 h-10 object-cover rounded"
                          />
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                        {url && (
                          <a
                            href={url}
                            download
                            className="text-blue-600"
                            title="Download photo"
                          >
                            <Download className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold text-gray-900">
                <tr>
                  <td className="px-2 py-2" colSpan={5}>
                    Total ({totals.count} receipt{totals.count === 1 ? "" : "s"})
                  </td>
                  <td className="text-right px-2 py-2 tabular-nums">
                    {formatMoney(totals.amount)}
                  </td>
                  <td className="text-right px-2 py-2 tabular-nums">
                    {formatMoney(totals.tax)}
                  </td>
                  <td colSpan={4} />
                  <td className="px-2 py-2" colSpan={2}>
                    <span className="text-orange-600">Owed {formatMoney(totals.owed)}</span>
                    <span className="text-gray-300 mx-1">·</span>
                    <span className="text-emerald-700">Paid {formatMoney(totals.paid)}</span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="text-[10px] text-gray-400">
        Location is where the receipt photo was taken (GPS, or approximate IP
        if GPS was denied). Older receipts captured before GPS tracking show
        &ldquo;—&rdquo;.
      </p>
    </PageContainer>
  );
}