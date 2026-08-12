"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { Camera, Loader2, MapPin, AlertCircle } from "lucide-react";
import { useToast } from "@/components/Toast";
import FieldCamera from "@/components/FieldCamera";
import { validateUpload } from "@/lib/uploadValidate";
import { resolveLocation, type GpsResult, type GpsStatus } from "@/lib/geo";

function PhotoUploadForm() {
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);
  const [gps, setGps] = useState<GpsResult | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("getting");
  const supabase = createClient();
  const toast = useToast();

  // Auto-grab location the moment the page opens so it's ready by the time the
  // user takes a photo — no manual "tag my location" tap needed. Falls back to
  // approximate IP location if GPS is denied. Initial status is "getting" so the
  // spinner shows immediately without a synchronous setState in the effect.
  async function getLocation() {
    const { result, status } = await resolveLocation();
    setGps(result);
    setGpsStatus(status);
  }

  useEffect(() => {
    supabase
      .from("jobs")
      .select("id, name")
      .then(({ data }) => setJobs(data ?? []));
    getLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !jobId) {
      toast.warning("Pick a job and a file");
      return;
    }
    const v = validateUpload(file, "image");
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }

    const ext = file.name.split(".").pop();
    const path = `${jobId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("job-photos")
      .upload(path, file);
    if (uploadError) {
      toast.error(`Upload failed: ${uploadError.message}`);
      setLoading(false);
      return;
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
      toast.error(`Save failed: ${dbError.message}`);
    } else {
      toast.success("Photo uploaded");
      setFile(null);
      setCaption("");
      setGps(null);
      setGpsStatus("getting");
      getLocation();
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Upload Photo" />
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

          <FieldCamera
            onCapture={(f) => {
              if (f) {
                const v = validateUpload(f, "image");
                if (!v.ok) {
                  toast.error(v.error);
                  setFile(null);
                  return;
                }
                setFile(f);
                if (!gps && gpsStatus !== "getting") {
                  setGpsStatus("getting");
                  getLocation();
                }
              } else {
                setFile(null);
              }
            }}
          />

          {file && (
            <p className="text-xs text-green-700 flex items-center gap-1">
              <Camera className="w-3.5 h-3.5" />
              Photo ready to upload{gps ? (gps.source === "ip" ? " · approximate location" : " · location tagged") : ""}
            </p>
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
            <span className="text-sm font-medium text-gray-700">Caption (optional)</span>
            <textarea
              placeholder="What's in the photo?"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Camera className="w-5 h-5" />
            )}
            {loading ? "Uploading..." : "Upload Photo"}
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