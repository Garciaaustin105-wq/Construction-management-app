"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
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
} from "lucide-react";
import {
  addReceipt,
  getReceiptsByJob,
  updateReceipt,
  deleteReceipt,
  type LocalReceipt,
} from "@/lib/receiptStore";
import { stampImage } from "@/lib/stampImage";

export type RemoteReceipt = {
  id: string;
  storage_path: string;
  vendor: string | null;
  amount: number | null;
  notes: string | null;
  captured_at: string;
  uploaded_by: string;
};

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
  const fileRef = useRef<HTMLInputElement>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [locals, setLocals] = useState<LocalReceipt[]>([]);
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
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
    refreshLocal();
  }, [supabase, refreshLocal]);

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
          const { data } = await supabase.storage
            .from("receipts")
            .createSignedUrl(r.storage_path, 3600);
          if (data?.signedUrl) entries[r.id] = data.signedUrl;
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

  // --- Capture (camera) ---------------------------------------------------
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCapturing(true);
    try {
      const { blob, thumb } = await stampImage(file, {
        date: new Date(),
        jobName,
      });
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
    const key = `local-${rec.localId}`;
    setBusyId(key);
    try {
      const path = `${jobId}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("receipts")
        .upload(path, rec.blob, { contentType: "image/jpeg" });
      if (upErr) {
        toast.error(`Upload failed: ${upErr.message}`);
        return;
      }
      const { data, error: dbErr } = await supabase
        .from("receipts")
        .insert({
          job_id: jobId,
          uploaded_by: userId,
          storage_path: path,
          vendor: rec.vendor || null,
          amount: rec.amount ?? null,
          notes: rec.notes || null,
          captured_at: rec.capturedAt,
        })
        .select("id")
        .single();
      if (dbErr || !data) {
        toast.error(`Save failed: ${dbErr?.message ?? "error"}`);
        // Clean up the orphaned storage object
        void supabase.storage.from("receipts").remove([path]);
        return;
      }
      await updateReceipt(rec.localId!, {
        shared: true,
        remoteId: data.id,
        storagePath: path,
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

  // --- Delete -------------------------------------------------------------
  async function removeLocal(rec: LocalReceipt) {
    if (!confirm("Delete this receipt? This can't be undone.")) return;
    const key = `local-${rec.localId}`;
    setBusyId(key);
    try {
      // If it was shared, also remove from cloud (this user owns it)
      if (rec.shared && rec.storagePath) {
        await supabase.storage.from("receipts").remove([rec.storagePath]);
        if (rec.remoteId) {
          await supabase.from("receipts").delete().eq("id", rec.remoteId);
        }
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
      await supabase.storage.from("receipts").remove([r.storage_path]);
      const { error } = await supabase.from("receipts").delete().eq("id", r.id);
      if (error) {
        toast.error(`Failed: ${error.message}`);
      } else {
        toast.success("Receipt deleted");
        // Best-effort: reload the page so the server-fetched list updates
        window.location.reload();
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
        {notShared > 0 ? ` · ${notShared} not shared` : ""})
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
          const thumb = isLocal
            ? rec.thumb
            : signedUrls[(v as { kind: "remote"; rec: RemoteReceipt }).rec.id];
          const busy = busyId === id;
          const shared = isLocal ? rec.shared : true;
          const canDeleteRemote =
            !isLocal && (role === "office" || r.uploaded_by === userId);

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
                  <div className="flex items-center gap-2">
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
                    <span className="text-xs text-gray-400 truncate">
                      {new Date(capturedAt).toLocaleDateString()}
                    </span>
                  </div>

                  {isLocal && !shared ? (
                    /* Editable fields before sharing */
                    <div className="mt-2 space-y-1.5">
                      <input
                        type="text"
                        placeholder="Vendor (optional)"
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
                          placeholder="Amount"
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
                        <input
                          type="text"
                          placeholder="Notes (optional)"
                          value={rec.notes ?? ""}
                          onChange={(e) => patchLocal(rec, { notes: e.target.value })}
                          className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded text-xs"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-gray-600 space-y-0.5">
                      {vendor && <p className="truncate">Vendor: {vendor}</p>}
                      {typeof amount === "number" && amount > 0 && (
                        <p>Amount: ${amount.toFixed(2)}</p>
                      )}
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
            className="flex-1 flex items-center justify-center p-4"
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