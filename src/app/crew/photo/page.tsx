"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { Camera, Loader2, MapPin, AlertCircle, X, Images, Upload } from "lucide-react";
import { useToast } from "@/components/Toast";
import FieldCamera from "@/components/FieldCamera";
import { validateUpload } from "@/lib/uploadValidate";
import { normalizeImage } from "@/lib/normalizeImage";
import { resolveLocation, type GpsResult, type GpsStatus } from "@/lib/geo";

type QStatus = "pending" | "uploading" | "done" | "error";
type QItem = { id: string; file: File; previewUrl: string; status: QStatus };

let queueSeq = 0;

function PhotoUploadForm() {
  const search = useSearchParams();
  const router = useRouter();
  const preselectedJob = search.get("job") ?? "";

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);
  const [gps, setGps] = useState<GpsResult | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("getting");
  const [showInPageCamera, setShowInPageCamera] = useState(false);
  const supabase = createClient();
  const toast = useToast();

  const takeRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLInputElement>(null);

  // Auto-grab location the moment the page opens so it's ready by the time the
  // user takes a photo — no manual "tag my location" tap needed. Falls back to
  // approximate IP location if GPS is denied.
  async function getLocation() {
    const { result, status } = await resolveLocation();
    setGps(result);
    setGpsStatus(status);
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("jobs").select("id, name").eq("type", "construction");
      setJobs(data ?? []);
      // Auto-grab location the moment the page opens so it's ready by the time
      // the user takes a photo (falls back to IP location if GPS is denied).
      await getLocation();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next: QItem[] = [];
    for (const file of Array.from(list)) {
      const v = validateUpload(file, "image");
      if (!v.ok) {
        toast.error(`${file.name}: ${v.error}`);
        continue;
      }
      next.push({
        id: `q${queueSeq++}`,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "pending",
      });
    }
    if (next.length > 0) {
      setQueue((prev) => [...prev, ...next]);
      if (!gps && gpsStatus !== "getting") {
        setGpsStatus("getting");
        getLocation();
      }
    }
    // reset inputs so the same file can be picked again later
    if (takeRef.current) takeRef.current.value = "";
    if (chooseRef.current) chooseRef.current.value = "";
  }

  function removeItem(id: string) {
    setQueue((prev) => {
      const item = prev.find((q) => q.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((q) => q.id !== id);
    });
  }

  function clearQueue() {
    setQueue((prev) => {
      for (const q of prev) URL.revokeObjectURL(q.previewUrl);
      return [];
    });
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const pending = queue.filter((q) => q.status === "pending");
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    if (pending.length === 0) {
      toast.warning("Add at least one photo");
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      return;
    }

    setLoading(true);
    let ok = 0;
    let fail = 0;

    // Upload sequentially so progress is predictable and we don't hammer the
    // bucket. Per-item status drives the thumbnails' spinner/check.
    for (const item of pending) {
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: "uploading" } : q))
      );
      // Normalize before upload: apply EXIF orientation and re-encode as JPEG so
      // the stored bytes are upright and renderable everywhere (incl. desktop
      // Chrome, which can't display HEIC). Falls back to the original file if
      // this browser can't decode it (rare), so a batch never stalls.
      const blob = await normalizeImage(item.file).catch(() => item.file);
      // timestamp + queue id guarantees uniqueness within a batch
      const path = `${jobId}/${Date.now()}-${item.id}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("job-photos")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (uploadError) {
        fail++;
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "error" } : q))
        );
        continue;
      }
      const { error: dbError } = await supabase.from("photos").insert({
        job_id: jobId,
        uploaded_by: user.id,
        storage_path: path,
        caption: caption || null,
        lat: gps?.lat ?? null,
        lng: gps?.lng ?? null,
        location_source: gps?.source ?? null,
        location_accuracy: gps?.accuracy ?? null,
      });
      if (dbError) {
        fail++;
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "error" } : q))
        );
      } else {
        ok++;
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "done" } : q))
        );
      }
    }

    setLoading(false);

    if (ok > 0) {
      toast.success(
        `Uploaded ${ok} photo${ok > 1 ? "s" : ""}${fail > 0 ? ` · ${fail} failed` : ""}`
      );
      // Auto-clear the screen + refresh so the user is ready for the next batch
      // without having to leave and come back.
      setCaption("");
      clearQueue();
      // re-resolve location for the next batch (in case they moved)
      setGps(null);
      setGpsStatus("getting");
      getLocation();
      router.refresh();
    } else if (fail > 0) {
      toast.error(`Upload failed for ${fail} photo${fail > 1 ? "s" : ""}`);
    }
  }

  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const doneCount = queue.filter((q) => q.status === "done").length;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Upload Photos"
        backHref={preselectedJob ? `/jobs/${preselectedJob}` : undefined}
        backLabel={
          jobs.find((j) => j.id === preselectedJob)?.name ?? "Back to job"
        }
      />
      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleUpload} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Job</span>
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">Select job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>

          {/* Native camera + library pickers.
              Take Photo uses capture="environment" so the phone opens its own
              camera app (full screen, all the phone's options). Choose Photos
              opens the gallery with multi-select so you can batch several. */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-gray-700 block">Photos</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => takeRef.current?.click()}
                className="bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5" />
                Take Photo
              </button>
              <button
                type="button"
                onClick={() => chooseRef.current?.click()}
                className="bg-white border border-gray-300 text-gray-900 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Images className="w-5 h-5" />
                Choose Photos
              </button>
            </div>
            <input
              ref={takeRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => addFiles(e.target.files)}
              className="hidden"
            />
            <input
              ref={chooseRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => setShowInPageCamera((v) => !v)}
              className="text-xs text-gray-500 active:text-gray-700 underline"
            >
              {showInPageCamera ? "Hide in-page camera" : "Camera not opening? Use in-page camera"}
            </button>
          </div>

          {/* In-page camera fallback (only if the native camera doesn't open
              the phone's camera app on this browser). Captures one at a time
              into the same queue. */}
          {showInPageCamera && (
            <FieldCamera
              onCapture={(f) => {
                if (f) {
                  const v = validateUpload(f, "image");
                  if (!v.ok) {
                    toast.error(v.error);
                    return;
                  }
                  const item: QItem = {
                    id: `q${queueSeq++}`,
                    file: f,
                    previewUrl: URL.createObjectURL(f),
                    status: "pending",
                  };
                  setQueue((prev) => [...prev, item]);
                  if (!gps && gpsStatus !== "getting") {
                    setGpsStatus("getting");
                    getLocation();
                  }
                }
              }}
            />
          )}

          {/* Queue thumbnails */}
          {queue.length > 0 && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {queue.map((q) => (
                  <div
                    key={q.id}
                    className="relative aspect-square bg-gray-200 rounded-lg overflow-hidden"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={q.previewUrl}
                      alt=""
                      className={`w-full h-full object-cover ${
                        q.status === "done" ? "opacity-40" : ""
                      }`}
                    />
                    {q.status === "uploading" && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-white animate-spin" />
                      </div>
                    )}
                    {q.status === "done" && (
                      <div className="absolute inset-0 bg-green-600/40 flex items-center justify-center">
                        <Camera className="w-5 h-5 text-white" />
                      </div>
                    )}
                    {q.status === "error" && (
                      <div className="absolute inset-0 bg-red-600/50 flex items-center justify-center">
                        <AlertCircle className="w-5 h-5 text-white" />
                      </div>
                    )}
                    {q.status !== "uploading" && (
                      <button
                        type="button"
                        onClick={() => removeItem(q.id)}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 active:bg-black/80"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">
                  {pendingCount} ready · {doneCount} uploaded
                </span>
                {queue.some((q) => q.status !== "uploading") && (
                  <button
                    type="button"
                    onClick={clearQueue}
                    className="text-gray-500 underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Location status — auto-captured on page open */}
          <div className="text-xs space-y-1.5">
            {gpsStatus === "ok" && gps ? (
              <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-2 py-1 rounded">
                <MapPin className="w-3.5 h-3.5" />
                Location tagged · {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
                {gps.accuracy ? ` (±${Math.round(gps.accuracy)}m)` : ""}
              </span>
            ) : gpsStatus === "ip" && gps ? (
              <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-1 rounded">
                <MapPin className="w-3.5 h-3.5" />
                Approximate location (network) · {gps.lat.toFixed(3)}, {gps.lng.toFixed(3)}
              </span>
            ) : gpsStatus === "getting" ? (
              <span className="inline-flex items-center gap-1 text-gray-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Getting location…
              </span>
            ) : gpsStatus === "denied" || gpsStatus === "unavailable" ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-1.5">
                <p className="flex items-center gap-1.5 text-amber-800 font-medium">
                  <AlertCircle className="w-4 h-4" />
                  Location is off — no precise pin will be saved
                </p>
                <p className="text-amber-700">
                  Enable location in your phone/browser settings to tag photos
                  with an exact spot. A rough network estimate will be used if
                  available.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setGpsStatus("getting");
                    getLocation();
                  }}
                  className="inline-flex items-center gap-1 text-amber-900 font-semibold underline"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  Try again
                </button>
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Caption (optional — applied to all)
            </span>
            <textarea
              placeholder="What's in the photo(s)?"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={2}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <button
            type="submit"
            disabled={loading || pendingCount === 0}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Upload className="w-5 h-5" />
            )}
            {loading
              ? "Uploading..."
              : `Upload ${pendingCount > 0 ? `${pendingCount} ` : ""}Photo${pendingCount === 1 ? "" : "s"}`}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function PhotoUploadPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}>
      <PhotoUploadForm />
    </Suspense>
  );
}