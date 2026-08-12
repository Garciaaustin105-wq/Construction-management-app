"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { formatMoney } from "@/lib/money";
import ReceiptsExportButton, {
  type ExportReceipt,
} from "@/components/ReceiptsExportButton";
import {
  X,
  Download,
  DollarSign,
  RotateCcw,
  Loader2,
  Receipt as ReceiptIcon,
  Users,
  FolderOpen,
} from "lucide-react";

export type ReceiptRow = {
  id: string;
  storage_path: string;
  uploaded_by: string;
  vendor: string | null;
  amount: number | null;
  tax: number | null;
  notes: string | null;
  captured_at: string;
  uploaded_by_name: string | null;
  reimbursed: boolean;
  reimbursed_at: string | null;
  category: string | null;
  payment_method: string | null;
  receipt_no: string | null;
  jobs: { name: string } | null;
};

export default function OfficeReceiptsList({ rows }: { rows: ReceiptRow[] }) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  // Uploader filter — "" = all users. Built from the people who actually have
  // receipts, so the dropdown only ever lists names tied to a receipt.
  const [filterUserId, setFilterUserId] = useState<string>("");

  const [detail, setDetail] = useState<ReceiptRow | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadingImg, setLoadingImg] = useState(false);
  const [busy, setBusy] = useState(false);

  // Unique uploaders, sorted by name.
  const uploaders = (() => {
    const map = new Map<string, string>(); // id → name
    for (const r of rows) {
      if (!r.uploaded_by) continue;
      map.set(r.uploaded_by, r.uploaded_by_name ?? "Unknown");
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  })();

  const filtered = filterUserId
    ? rows.filter((r) => r.uploaded_by === filterUserId)
    : rows;

  // Summary reflects the current filter.
  const totalAmount = filtered.reduce((s, r) => s + (r.amount ?? 0), 0);
  const owedRows = filtered.filter((r) => !r.reimbursed);
  const paidRows = filtered.filter((r) => r.reimbursed);
  const owedAmount = owedRows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const paidAmount = paidRows.reduce((s, r) => s + (r.amount ?? 0), 0);

  const exportRows: ExportReceipt[] = filtered.map((r) => ({
    id: r.id,
    jobName: r.jobs?.name ?? "—",
    vendor: r.vendor,
    amount: r.amount,
    capturedAt: r.captured_at,
    uploader: r.uploaded_by_name,
    reimbursed: r.reimbursed,
    reimbursedAt: r.reimbursed_at,
    notes: r.notes,
    category: r.category,
    tax: r.tax,
    paymentMethod: r.payment_method,
    receiptNo: r.receipt_no,
  }));

  // Group filtered receipts by job, each job's receipts newest-first, and jobs
  // ordered by their newest receipt (most active job first).
  type JobGroup = { name: string; owed: ReceiptRow[]; paid: ReceiptRow[]; latest: string };
  const jobGroups: JobGroup[] = (() => {
    const map = new Map<string, ReceiptRow[]>();
    for (const r of filtered) {
      const key = r.jobs?.name ?? "No job";
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return [...map.entries()]
      .map(([name, rs]) => {
        const sorted = [...rs].sort((a, b) =>
          b.captured_at.localeCompare(a.captured_at)
        );
        return {
          name,
          owed: sorted.filter((r) => !r.reimbursed),
          paid: sorted.filter((r) => r.reimbursed),
          latest: sorted[0]?.captured_at ?? "",
        };
      })
      .sort((a, b) => b.latest.localeCompare(a.latest));
  })();

  // --- Detail modal -------------------------------------------------------
  async function openDetail(r: ReceiptRow) {
    setDetail(r);
    setImgUrl(null);
    setLoadingImg(true);
    try {
      const { data } = await supabase.storage
        .from("receipts")
        .createSignedUrl(r.storage_path, 3600);
      if (data?.signedUrl) setImgUrl(data.signedUrl);
    } finally {
      setLoadingImg(false);
    }
  }

  function closeDetail() {
    setDetail(null);
    setImgUrl(null);
    setLoadingImg(false);
  }

  useEffect(() => {
    if (!detail) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDetail();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  async function toggleReimbursed(r: ReceiptRow) {
    setBusy(true);
    try {
      const reimbursed = !r.reimbursed;
      const { error } = await supabase
        .from("receipts")
        .update({
          reimbursed,
          reimbursed_at: reimbursed ? new Date().toISOString() : null,
        })
        .eq("id", r.id);
      if (error) {
        toast.error(`Failed: ${error.message}`);
      } else {
        toast.success(reimbursed ? "Marked paid back" : "Marked unpaid");
        closeDetail();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function download(r: ReceiptRow) {
    if (!imgUrl) {
      toast.error("Image still loading");
      return;
    }
    try {
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = fileName(r);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 4000);
    } catch {
      toast.error("Could not download image");
    }
  }

  // --- Compact row (tappable → detail) ------------------------------------
  function Row({ r }: { r: ReceiptRow }) {
    return (
      <button
        onClick={() => openDetail(r)}
        className="w-full text-left p-3 flex justify-between items-start gap-2 active:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">
            {r.vendor ?? "No vendor"}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {new Date(r.captured_at).toLocaleDateString()} ·{" "}
            {r.uploaded_by_name ?? "—"}
          </p>
          {(r.category || r.payment_method) && (
            <div className="flex flex-wrap gap-1 mt-1">
              {r.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                  {r.category}
                </span>
              )}
              {r.payment_method && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                  {r.payment_method}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-sm font-bold text-gray-900">
            {formatMoney(r.amount ?? 0)}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${
              r.reimbursed
                ? "bg-emerald-100 text-emerald-700"
                : "bg-orange-100 text-orange-700"
            }`}
          >
            {r.reimbursed ? "Paid back" : "Owed"}
          </span>
        </div>
      </button>
    );
  }

  // Sub-section within a job (owed or paid).
  function JobSubSection({
    label,
    items,
    tone,
  }: {
    label: string;
    items: ReceiptRow[];
    tone: "owed" | "paid";
  }) {
    if (items.length === 0) return null;
    return (
      <div>
        <p
          className={`text-[10px] font-semibold uppercase px-3 pt-2 pb-1 ${
            tone === "owed" ? "text-orange-600" : "text-emerald-600"
          }`}
        >
          {label} ({items.length})
        </p>
        <div className="divide-y divide-gray-100">
          {items.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Uploader filter */}
      <div className="bg-white rounded-lg p-3 shadow-sm">
        <label className="text-[10px] uppercase font-semibold text-gray-500 flex items-center gap-1 mb-1">
          <Users className="w-3.5 h-3.5" />
          Filter by uploader
        </label>
        <select
          value={filterUserId}
          onChange={(e) => setFilterUserId(e.target.value)}
          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">All users ({rows.length})</option>
          {uploaders.map((u) => {
            const count = rows.filter((r) => r.uploaded_by === u.id).length;
            return (
              <option key={u.id} value={u.id}>
                {u.name} ({count})
              </option>
            );
          })}
        </select>
      </div>

      {/* Summary — tracks the current filter */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white rounded-lg p-3 shadow-sm text-center">
          <p className="text-[10px] uppercase font-semibold text-gray-500">
            Total
          </p>
          <p className="text-sm font-bold text-gray-900 mt-0.5">
            {formatMoney(totalAmount)}
          </p>
          <p className="text-[10px] text-gray-400">{filtered.length} receipts</p>
        </div>
        <div className="bg-orange-50 rounded-lg p-3 text-center">
          <p className="text-[10px] uppercase font-semibold text-orange-600">
            Owed
          </p>
          <p className="text-sm font-bold text-orange-700 mt-0.5">
            {formatMoney(owedAmount)}
          </p>
          <p className="text-[10px] text-orange-500">{owedRows.length} unpaid</p>
        </div>
        <div className="bg-emerald-50 rounded-lg p-3 text-center">
          <p className="text-[10px] uppercase font-semibold text-emerald-600">
            Paid back
          </p>
          <p className="text-sm font-bold text-emerald-700 mt-0.5">
            {formatMoney(paidAmount)}
          </p>
          <p className="text-[10px] text-emerald-500">{paidRows.length} settled</p>
        </div>
      </div>

      <ReceiptsExportButton rows={exportRows} />

      {/* Grouped by job */}
      {jobGroups.length === 0 ? (
        <div className="bg-white rounded-lg p-4 text-center text-sm text-gray-500">
          No receipts for this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {jobGroups.map((job) => (
            <section key={job.name}>
              <h2 className="text-sm font-semibold text-gray-700 uppercase mb-2 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-gray-400" />
                {job.name}
                <span className="text-gray-400 font-normal normal-case">
                  ({job.owed.length + job.paid.length})
                </span>
              </h2>
              <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                <JobSubSection
                  label="Yet to be paid"
                  items={job.owed}
                  tone="owed"
                />
                <JobSubSection label="Paid back" items={job.paid} tone="paid" />
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {detail && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex flex-col"
          onClick={closeDetail}
        >
          <div className="flex items-center justify-between p-3 text-white">
            <button onClick={closeDetail} className="p-2" title="Close">
              <X className="w-6 h-6" />
            </button>
            <span className="text-xs truncate max-w-[70%]">
              {detail.vendor ?? "Receipt"} ·{" "}
              {new Date(detail.captured_at).toLocaleDateString()}
            </span>
            <span className="w-8" />
          </div>

          <div
            className="flex-1 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="max-w-md mx-auto p-4">
              {/* Image */}
              <div className="bg-white/10 rounded-lg overflow-hidden flex items-center justify-center min-h-[200px]">
                {loadingImg ? (
                  <Loader2 className="w-8 h-8 text-white/70 animate-spin" />
                ) : imgUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imgUrl}
                    alt="Receipt"
                    className="w-full object-contain"
                  />
                ) : (
                  <div className="p-8 text-white/60 text-sm flex flex-col items-center gap-2">
                    <ReceiptIcon className="w-10 h-10" />
                    Image unavailable
                  </div>
                )}
              </div>

              {/* Details */}
              <div className="bg-white rounded-lg p-4 mt-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div className="min-w-0">
                    <p className="font-bold text-gray-900 truncate">
                      {detail.vendor ?? "No vendor"}
                    </p>
                    <p className="text-xs text-blue-600">
                      {detail.jobs?.name ?? "—"}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-gray-900">
                    {formatMoney(detail.amount ?? 0)}
                  </span>
                </div>

                <dl className="text-sm text-gray-700 space-y-1 pt-2 border-t border-gray-100">
                  {typeof detail.tax === "number" && detail.tax > 0 && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Tax</dt>
                      <dd>{formatMoney(detail.tax)}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Date</dt>
                    <dd>{new Date(detail.captured_at).toLocaleString()}</dd>
                  </div>
                  {detail.uploaded_by_name && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Uploaded by</dt>
                      <dd className="truncate ml-2">{detail.uploaded_by_name}</dd>
                    </div>
                  )}
                  {detail.category && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Category</dt>
                      <dd>{detail.category}</dd>
                    </div>
                  )}
                  {detail.payment_method && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Payment</dt>
                      <dd>{detail.payment_method}</dd>
                    </div>
                  )}
                  {detail.receipt_no && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Receipt #</dt>
                      <dd className="font-mono">{detail.receipt_no}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Status</dt>
                    <dd
                      className={
                        detail.reimbursed ? "text-emerald-600" : "text-orange-600"
                      }
                    >
                      {detail.reimbursed
                        ? `Paid back${detail.reimbursed_at ? ` · ${new Date(detail.reimbursed_at).toLocaleDateString()}` : ""}`
                        : "Owed"}
                    </dd>
                  </div>
                  {detail.notes && (
                    <div className="pt-2 border-t border-gray-100">
                      <dt className="text-gray-500 text-xs uppercase mb-1">
                        Notes
                      </dt>
                      <dd className="text-gray-700 whitespace-pre-wrap">
                        {detail.notes}
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Actions */}
                <div className="flex gap-2 pt-3 border-t border-gray-100">
                  <button
                    onClick={() => toggleReimbursed(detail)}
                    disabled={busy}
                    className={`flex-1 py-2.5 rounded text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5 ${
                      detail.reimbursed
                        ? "bg-white border border-gray-300 text-gray-700 active:bg-gray-50"
                        : "bg-emerald-600 text-white active:bg-emerald-700"
                    }`}
                  >
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : detail.reimbursed ? (
                      <RotateCcw className="w-4 h-4" />
                    ) : (
                      <DollarSign className="w-4 h-4" />
                    )}
                    {detail.reimbursed ? "Mark unpaid" : "Mark paid back"}
                  </button>
                  <button
                    onClick={() => download(detail)}
                    disabled={!imgUrl}
                    className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded text-sm font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-4 h-4" />
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function fileName(r: ReceiptRow) {
  const d = new Date(r.captured_at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = (r.vendor ?? r.jobs?.name ?? "receipt")
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(0, 30);
  return `receipt-${stamp}-${safe}.jpg`;
}
function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}