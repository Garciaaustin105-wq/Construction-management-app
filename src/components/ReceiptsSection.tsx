"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signedThumbnail } from "@/lib/storage";
import { useToast } from "@/components/Toast";
import {
  Camera,
  Loader2,
  Send,
  Download,
  Trash2,
  CheckCircle2,
  Receipt as ReceiptIcon,
  X,
  DollarSign,
  RotateCcw,
} from "lucide-react";
import {
  addReceipt,
  getReceiptsByJob,
  updateReceipt,
  deleteReceipt,
  type LocalReceipt,
} from "@/lib/receiptStore";
import { stampImage } from "@/lib/stampImage";
import { validateUpload } from "@/lib/uploadValidate";
import { resolveLocation } from "@/lib/geo";

export type RemoteReceipt = {
  id: string;
  storage_path: string;
  vendor: string | null;
  amount: number | null;
  notes: string | null;
  captured_at: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  reimbursed: boolean;
  reimbursed_at: string | null;
  category: string | null;
  tax: number | null;
  payment_method: string | null;
  receipt_no: string | null;
  cost_code_id: string | null;
};

// Shared option lists for the receipt editor + display.
export const RECEIPT_CATEGORIES = [
  "Materials",
  "Fuel",
  "Tools / Equipment",
  "Travel / Mileage",
  "Meals",
  "Permits / Fees",
  "Other",
];
export const PAYMENT_METHODS = [
  "Cash",
  "Personal Card",
  "Company Card",
  "Account",
];

type ViewReceipt =
  | { kind: "local"; rec: LocalReceipt }
  | { kind: "remote"; rec: RemoteReceipt };

export default function ReceiptsSection({
  jobId,
  jobName,
  role,
  remoteReceipts,
}: {
  jobId: string;
  jobName: string;
  role: string;
  remoteReceipts: RemoteReceipt[];
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [locals, setLocals] = useState<LocalReceipt[]>([]);
  const [costCodes, setCostCodes] = useState<{ id: string; code: string; name: string }[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // id of receipt mid-action
  const [lightbox, setLightbox] = useState<{
    url: string;
    label: string;
  } | null>(null);

  // Current user + local receipts for this job
  const refreshLocal = useCallback(async () => {
    try {
      setLocals(await getReceiptsByJob(jobId));
    } catch {
      // IndexedDB unavailable (SSR / private mode) — silently no-op
    }
  }, [jobId]);

  useEffect(() => {
    (async () => {
      // getUser, cost_codes, and refreshLocal are independent — fan them out
      // instead of awaiting one after another. The profile read depends on the
      // user id, so it follows getUser.
      const [userRes, codesRes] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);
      const id = userRes.data.user?.id ?? null;
      setUserId(id);
      setCostCodes(codesRes.data ?? []);
      // refreshLocal is awaited inside the IIFE so the setLocals() it triggers
      // lands after an await, not synchronously in the effect body
      // (react-hooks/set-state-in-effect). It runs in parallel with the profile
      // read when there's a user, or alone otherwise.
      if (id) {
        const [profRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("full_name")
            .eq("id", id)
            .single(),
          refreshLocal(),
        ]);
        if (profRes.data?.full_name) setUserName(profRes.data.full_name);
      } else {
        await refreshLocal();
      }
    })();
  }, [supabase, refreshLocal]);

  // Look up remote records by id so shared local receipts can read
  // reimbursed / uploader info that lives on the server row.
  const remoteById = new Map(remoteReceipts.map((r) => [r.id, r]));

  // Signed URLs for remote receipts that aren't mirrored locally
  const remoteOnly = remoteReceipts.filter(
    (r) => !locals.some((l) => l.remoteId === r.id)
  );
  useEffect(() => {
    let cancelled = false;
    if (remoteOnly.length === 0) return;
    (async () => {
      const entries: Record<string, string> = {};
      await Promise.all(
        remoteOnly.map(async (r) => {
          // 128px transformed thumbnail for the 64px list tile — KBs, not the
          // full-res original. (The lightbox / download paths mint full-res
          // separately, on demand.)
          const url = await signedThumbnail(
            supabase,
            "receipts",
            r.storage_path,
            128
          );
          if (url) entries[r.id] = url;
        })
      );
      if (!cancelled) setSignedUrls((prev) => ({ ...prev, ...entries }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteOnly.map((r) => r.id).join(",")]);

  // Build the merged, deduped, sorted view list
  const views: ViewReceipt[] = [
    ...locals.map((rec) => ({ kind: "local" as const, rec })),
    ...remoteOnly.map((rec) => ({ kind: "remote" as const, rec })),
  ].sort((a, b) => {
    const da = a.kind === "local" ? a.rec.capturedAt : a.rec.captured_at;
    const db = b.kind === "local" ? b.rec.capturedAt : b.rec.captured_at;
    return db.localeCompare(da);
  });

  const notShared = locals.filter((l) => !l.shared).length;
  const owedCount = remoteReceipts.filter((r) => !r.reimbursed).length;

  // --- Capture (camera) ---------------------------------------------------
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = validateUpload(file, "image");
    if (!v.ok) {
      toast.error(v.error);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setCapturing(true);
    try {
      const { blob, thumb } = await stampImage(file, {
        date: new Date(),
        jobName,
      });
      // Resolve capture location in parallel with the stamp so we record
      // where the receipt was taken (GPS, falling back to IP geolocation).
      // Never blocks the save — a failed/absent fix just leaves null.
      const gps = await resolveLocation().catch(() => null);
      const localId = await addReceipt({
        jobId,
        jobName,
        blob,
        thumb,
        vendor: "",
        amount: undefined,
        notes: "",
        capturedAt: new Date().toISOString(),
        shared: false,
        lat: gps?.result?.lat ?? null,
        lng: gps?.result?.lng ?? null,
        locationSource: gps?.result?.source ?? null,
        locationAccuracy: gps?.result?.accuracy ?? null,
      });
      void refreshLocal();
      toast.success("Receipt saved on phone");
      void localId;
    } catch (err) {
      toast.error(
        `Could not process image: ${err instanceof Error ? err.message : "error"}`
      );
    } finally {
      setCapturing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // --- Share with office --------------------------------------------------
  async function share(rec: LocalReceipt) {
    if (!userId) {
      toast.error("Not signed in");
      return;
    }
    // Vendor + amount are required so the office has complete tax records.
    if (!rec.vendor?.trim()) {
      toast.warning("Add a vendor before sharing with the office");
      return;
    }
    if (typeof rec.amount !== "number" || Number.isNaN(rec.amount) || rec.amount <= 0) {
      toast.warning("Add an amount before sharing with the office");
      return;
    }
    const key = `local-${rec.localId}`;
    setBusyId(key);
    try {
      // Route through our server API (service role) so crew uploads don't
      // depend on per-crew storage RLS policies.
      const form = new FormData();
      form.append("jobId", jobId);
      form.append("capturedAt", rec.capturedAt);
      if (rec.vendor) form.append("vendor", rec.vendor);
      if (typeof rec.amount === "number") form.append("amount", String(rec.amount));
      if (rec.notes) form.append("notes", rec.notes);
      if (rec.category) form.append("category", rec.category);
      if (typeof rec.tax === "number") form.append("tax", String(rec.tax));
      if (rec.paymentMethod) form.append("paymentMethod", rec.paymentMethod);
      if (rec.receiptNo) form.append("receiptNo", rec.receiptNo);
      if (rec.costCodeId) form.append("costCodeId", rec.costCodeId);
      if (typeof rec.lat === "number") form.append("lat", String(rec.lat));
      if (typeof rec.lng === "number") form.append("lng", String(rec.lng));
      if (rec.locationSource) form.append("locationSource", rec.locationSource);
      if (typeof rec.locationAccuracy === "number")
        form.append("locationAccuracy", String(rec.locationAccuracy));
      form.append("file", rec.blob, "receipt.jpg");

      const res = await fetch("/api/receipts/share", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Share failed (${res.status})`);
        return;
      }
      await updateReceipt(rec.localId!, {
        shared: true,
        remoteId: data.id,
        storagePath: data.storagePath,
      });
      await refreshLocal();
      toast.success("Shared with office");
    } finally {
      setBusyId(null);
    }
  }

  // --- Save to device -----------------------------------------------------
  async function downloadLocal(rec: LocalReceipt) {
    const url = URL.createObjectURL(rec.blob);
    triggerDownload(url, fileName(rec.capturedAt, jobName, rec.vendor));
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function downloadRemote(r: RemoteReceipt) {
    const key = `remote-${r.id}`;
    setBusyId(key);
    try {
      let url: string | undefined = signedUrls[r.id];
      if (!url) {
        const { data } = await supabase.storage
          .from("receipts")
          .createSignedUrl(r.storage_path, 60);
        url = data?.signedUrl;
      }
      if (!url) {
        toast.error("Could not load image");
        return;
      }
      const res = await fetch(url);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      triggerDownload(obj, fileName(r.captured_at, jobName, r.vendor ?? undefined));
      setTimeout(() => URL.revokeObjectURL(obj), 4000);
    } finally {
      setBusyId(null);
    }
  }

  // --- Toggle paid-back (office only) -------------------------------------
  async function toggleReimbursed(remoteId: string, currently: boolean) {
    const key = `reimburse-${remoteId}`;
    setBusyId(key);
    try {
      const reimbursed = !currently;
      const { error } = await supabase
        .from("receipts")
        .update({
          reimbursed,
          reimbursed_at: reimbursed ? new Date().toISOString() : null,
        })
        .eq("id", remoteId);
      if (error) {
        toast.error(`Failed: ${error.message}`);
      } else {
        toast.success(reimbursed ? "Marked paid back" : "Marked unpaid");
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  // --- Delete -------------------------------------------------------------
  async function removeLocal(rec: LocalReceipt) {
    if (!confirm("Delete this receipt? This can't be undone.")) return;
    const key = `local-${rec.localId}`;
    setBusyId(key);
    try {
      // If it was shared, remove the cloud copy via the server API (service
      // role) so crew deletes don't depend on storage RLS.
      if (rec.shared && rec.remoteId) {
        await fetch(`/api/receipts/${rec.remoteId}`, { method: "DELETE" });
      }
      await deleteReceipt(rec.localId!);
      await refreshLocal();
      toast.success("Receipt deleted");
    } finally {
      setBusyId(null);
    }
  }
  async function removeRemote(r: RemoteReceipt) {
    if (!confirm("Delete this shared receipt? Removes it for everyone.")) return;
    const key = `remote-${r.id}`;
    setBusyId(key);
    try {
      const res = await fetch(`/api/receipts/${r.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error ?? `Failed (${res.status})`);
      } else {
        toast.success("Receipt deleted");
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  // --- Inline metadata edit (local only) ----------------------------------
  async function patchLocal(
    rec: LocalReceipt,
    patch: Partial<LocalReceipt>
  ) {
    await updateReceipt(rec.localId!, patch);
    setLocals((prev) =>
      prev.map((l) => (l.localId === rec.localId ? { ...l, ...patch } : l))
    );
  }

  // --- Lightbox -----------------------------------------------------------
  function openLocal(rec: LocalReceipt) {
    const url = URL.createObjectURL(rec.blob);
    setLightbox({ url, label: metaLabel(rec.capturedAt, rec.vendor) });
  }
  async function openRemote(r: RemoteReceipt) {
    let url: string | undefined = signedUrls[r.id];
    if (!url) {
      const { data } = await supabase.storage
        .from("receipts")
        .createSignedUrl(r.storage_path, 3600);
      url = data?.signedUrl;
    }
    if (url) setLightbox({ url, label: metaLabel(r.captured_at, r.vendor ?? undefined) });
  }
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLightbox();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox]);
  function closeLightbox() {
    if (lightbox) URL.revokeObjectURL(lightbox.url);
    setLightbox(null);
  }

  // ------------------------------------------------------------------------
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-2">
        <ReceiptIcon className="w-4 h-4" />
        Receipts ({views.length}
        {notShared > 0 ? ` · ${notShared} not shared` : ""}
        {owedCount > 0 ? ` · ${owedCount} owed` : ""})
      </h2>

      {/* Capture button */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPickFile}
        className="hidden"
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={capturing}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 mb-3"
      >
        {capturing ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Camera className="w-5 h-5" />
        )}
        {capturing ? "Processing..." : "Add Receipt"}
      </button>

      {/* List */}
      <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
        {views.length === 0 && (
          <div className="py-6 flex flex-col items-center text-center">
            <div className="w-10 h-10 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-2">
              <ReceiptIcon className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-gray-700">No receipts yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              Tap &ldquo;Add Receipt&rdquo; to photograph an expense. It stays on
              this phone until you share it with the office.
            </p>
          </div>
        )}

        {views.map((v) => {
          const isLocal = v.kind === "local";
          const rec = v.rec as LocalReceipt;
          const r = v.rec as RemoteReceipt;
          const id = isLocal ? `local-${rec.localId}` : `remote-${r.id}`;
          const capturedAt = isLocal ? rec.capturedAt : r.captured_at;
          const vendor = isLocal ? rec.vendor : r.vendor;
          const amount = isLocal ? rec.amount : r.amount;
          const notes = isLocal ? rec.notes : r.notes;
          const category = isLocal ? rec.category : r.category;
          const tax = isLocal ? rec.tax : r.tax;
          const paymentMethod = isLocal ? rec.paymentMethod : r.payment_method;
          const receiptNo = isLocal ? rec.receiptNo : r.receipt_no;
          const costCodeId = isLocal ? rec.costCodeId : r.cost_code_id;
          const costCode = costCodeId
            ? costCodes.find((c) => c.id === costCodeId)
            : undefined;
          const thumb = isLocal
            ? rec.thumb
            : signedUrls[(v as { kind: "remote"; rec: RemoteReceipt }).rec.id];
          const busy = busyId === id;
          const shared = isLocal ? rec.shared : true;
          const canDeleteRemote =
            !isLocal && (role === "office" || r.uploaded_by === userId);

          // Reconcile server-side fields (reimbursed) for shared local receipts
          const remoteRow = isLocal
            ? rec.shared && rec.remoteId
              ? remoteById.get(rec.remoteId)
              : undefined
            : r;
          const reimbursed = remoteRow?.reimbursed ?? false;
          const uploader = isLocal
            ? userName || "You"
            : r.uploaded_by_name ?? "—";
          const toggleId = isLocal
            ? rec.shared
              ? rec.remoteId
              : null
            : r.id;

          return (
            <div key={id} className="p-3">
              <div className="flex gap-3">
                {/* Thumbnail */}
                <button
                  onClick={() =>
                    isLocal ? openLocal(rec) : openRemote(r)
                  }
                  className="w-16 h-16 rounded-lg bg-gray-100 overflow-hidden flex-shrink-0 active:opacity-70"
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt="Receipt thumbnail"
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      {isLocal ? (
                        <ReceiptIcon className="w-6 h-6" />
                      ) : (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      )}
                    </div>
                  )}
                </button>

                {/* Meta + actions */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${
                        shared
                          ? "bg-green-100 text-green-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {shared ? (
                        <span className="inline-flex items-center gap-0.5">
                          <CheckCircle2 className="w-3 h-3" /> Shared
                        </span>
                      ) : (
                        "On phone"
                      )}
                    </span>
                    {shared && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${
                          reimbursed
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-orange-100 text-orange-700"
                        }`}
                      >
                        {reimbursed ? "Paid back" : "Owed"}
                      </span>
                    )}
                    <span className="text-xs text-gray-400 truncate">
                      {new Date(capturedAt).toLocaleDateString()}
                    </span>
                  </div>

                  {isLocal && !shared ? (
                    /* Editable fields before sharing */
                    <div className="mt-2 space-y-1.5">
                      <input
                        type="text"
                        placeholder="Vendor (required)"
                        value={rec.vendor ?? ""}
                        onChange={(e) => patchLocal(rec, { vendor: e.target.value })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
                      />
                      <div className="flex gap-1.5">
                        <span className="text-gray-400 text-xs self-center">$</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          placeholder="Amount (required)"
                          value={rec.amount ?? ""}
                          onChange={(e) =>
                            patchLocal(rec, {
                              amount: e.target.value
                                ? Number(e.target.value)
                                : undefined,
                            })
                          }
                          className="w-24 px-2 py-1.5 border border-gray-300 rounded text-xs"
                        />
                        <span className="text-gray-400 text-xs self-center">tax $</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          placeholder="Tax"
                          value={rec.tax ?? ""}
                          onChange={(e) =>
                            patchLocal(rec, {
                              tax: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                          className="w-20 px-2 py-1.5 border border-gray-300 rounded text-xs"
                        />
                      </div>
                      <div className="flex gap-1.5">
                        <select
                          value={rec.category ?? ""}
                          onChange={(e) => patchLocal(rec, { category: e.target.value || undefined })}
                          className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                        >
                          <option value="">Category…</option>
                          {RECEIPT_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                        <select
                          value={rec.paymentMethod ?? ""}
                          onChange={(e) => patchLocal(rec, { paymentMethod: e.target.value || undefined })}
                          className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                        >
                          <option value="">Paid with…</option>
                          {PAYMENT_METHODS.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <input
                        type="text"
                        placeholder="Receipt # (optional)"
                        value={rec.receiptNo ?? ""}
                        onChange={(e) => patchLocal(rec, { receiptNo: e.target.value || undefined })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
                      />
                      <select
                        value={rec.costCodeId ?? ""}
                        onChange={(e) => patchLocal(rec, { costCodeId: e.target.value || null })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs bg-white"
                      >
                        <option value="">Cost code (optional)…</option>
                        {costCodes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} · {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        placeholder="Notes (optional)"
                        value={rec.notes ?? ""}
                        onChange={(e) => patchLocal(rec, { notes: e.target.value })}
                        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
                      />
                      {(!rec.vendor?.trim() ||
                        typeof rec.amount !== "number" ||
                        rec.amount <= 0) && (
                        <p className="text-[10px] text-amber-600">
                          Vendor &amp; amount required to share with office
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-gray-600 space-y-0.5">
                      {vendor && <p className="truncate">Vendor: {vendor}</p>}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {typeof amount === "number" && amount > 0 && (
                          <span>Amount: ${amount.toFixed(2)}</span>
                        )}
                        {typeof tax === "number" && tax > 0 && (
                          <span className="text-gray-500">Tax: ${tax.toFixed(2)}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {category && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                            {category}
                          </span>
                        )}
                        {paymentMethod && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                            {paymentMethod}
                          </span>
                        )}
                        {costCode && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium font-mono">
                            {costCode.code}
                          </span>
                        )}
                      </div>
                      {receiptNo && (
                        <p className="truncate text-gray-500">Receipt #: {receiptNo}</p>
                      )}
                      <p className="truncate text-gray-500">
                        Uploaded by {uploader}
                      </p>
                      {notes && <p className="truncate">Notes: {notes}</p>}
                    </div>
                  )}
                </div>
              </div>

              {/* Action row */}
              <div className="flex gap-2 mt-2">
                {!shared && isLocal && (
                  <button
                    onClick={() => share(rec)}
                    disabled={busy}
                    className="flex-1 bg-green-600 text-white py-2 rounded text-xs font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {busy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Send to office
                  </button>
                )}
                {role === "office" && shared && toggleId && (
                  <button
                    onClick={() => toggleReimbursed(toggleId, reimbursed)}
                    disabled={busy}
                    className={`flex-1 py-2 rounded text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1 ${
                      reimbursed
                        ? "bg-white border border-gray-300 text-gray-700 active:bg-gray-50"
                        : "bg-emerald-600 text-white active:bg-emerald-700"
                    }`}
                  >
                    {busyId === `reimburse-${toggleId}` ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : reimbursed ? (
                      <RotateCcw className="w-3.5 h-3.5" />
                    ) : (
                      <DollarSign className="w-3.5 h-3.5" />
                    )}
                    {reimbursed ? "Mark unpaid" : "Mark paid back"}
                  </button>
                )}
                <button
                  onClick={() =>
                    isLocal ? downloadLocal(rec) : downloadRemote(r)
                  }
                  disabled={busy}
                  className="flex-1 bg-white border border-gray-300 text-gray-700 py-2 rounded text-xs font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" />
                  Save
                </button>
                {(isLocal || canDeleteRemote) && (
                  <button
                    onClick={() =>
                      isLocal ? removeLocal(rec) : removeRemote(r)
                    }
                    disabled={busy}
                    className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs font-semibold active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[100] bg-black flex flex-col"
          onClick={closeLightbox}
        >
          <div className="flex items-center justify-between p-3 text-white">
            <button onClick={closeLightbox} className="p-2" title="Close">
              <X className="w-6 h-6" />
            </button>
            <span className="text-xs truncate max-w-[70%]">{lightbox.label}</span>
            <span className="w-8" />
          </div>
          <div
            className="flex-1 min-h-0 flex items-center justify-center p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt="Receipt"
              className="max-w-full max-h-full object-contain"
            />
          </div>
        </div>
      )}
    </section>
  );
}

// --- helpers --------------------------------------------------------------

function fileName(capturedAt: string, jobName: string, vendor?: string) {
  const d = new Date(capturedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const safe = (vendor || jobName).replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
  return `receipt-${stamp}-${safe}.jpg`;
}
function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}
function metaLabel(capturedAt: string, vendor?: string) {
  const v = vendor ? `${vendor} · ` : "";
  return `${v}${new Date(capturedAt).toLocaleString()}`;
}
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}