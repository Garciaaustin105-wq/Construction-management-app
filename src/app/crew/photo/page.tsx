"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { Camera, Loader2, MapPin } from "lucide-react";
import { useToast } from "@/components/Toast";
import FieldCamera from "@/components/FieldCamera";
import { validateUpload } from "@/lib/uploadValidate";

type GPS = { lat: number; lng: number };
type GpsStatus = "idle" | "getting" | "ok" | "denied" | "unavailable";

function PhotoUploadForm() {
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);
  const [gps, setGps] = useState<GPS | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");
  const supabase = createClient();
  const toast = useToast();

  function getLocation() {
    if (!("geolocation" in navigator)) {
      setGpsStatus("unavailable");
      return;
    }
    setGpsStatus("getting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsStatus("ok");
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  useEffect(() => {
    supabase
      .from("jobs")
      .select("id, name")
      .then(({ data }) => setJobs(data ?? []));
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
    });
    if (dbError) {
      toast.error(`Save failed: ${dbError.message}`);
    } else {
      toast.success("Photo uploaded");
      setFile(null);
      setCaption("");
      setGps(null);
      setGpsStatus("idle");
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
                if (gpsStatus === "idle") getLocation();
              } else {
                setFile(null);
              }
            }}
          />

          {file && (
            <p className="text-xs text-green-700 flex items-center gap-1">
              <Camera className="w-3.5 h-3.5" />
              Photo ready to upload{gps ? " · location tagged" : ""}
            </p>
          )}

          {/* GPS status */}
          <div className="flex items-center gap-2 text-xs">
            {gpsStatus === "ok" && gps ? (
              <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-2 py-1 rounded">
                <MapPin className="w-3.5 h-3.5" />
                Location tagged · {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
              </span>
            ) : gpsStatus === "getting" ? (
              <span className="inline-flex items-center gap-1 text-gray-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Getting location…
              </span>
            ) : (
              <button
                type="button"
                onClick={getLocation}
                className="inline-flex items-center gap-1 text-blue-600 active:opacity-70 px-2 py-1 rounded"
              >
                <MapPin className="w-3.5 h-3.5" />
                {gpsStatus === "denied"
                  ? "Location denied — tap to retry"
                  : gpsStatus === "unavailable"
                    ? "Location unavailable"
                    : "Tag my location"}
              </button>
            )}
            {gpsStatus !== "ok" && (
              <span className="text-gray-400">
                Optional — adds a map pin to this photo
              </span>
            )}
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