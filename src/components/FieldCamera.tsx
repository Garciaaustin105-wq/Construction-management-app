"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, RefreshCw, SwitchCamera, Loader2, ImageIcon, Check } from "lucide-react";
import { useToast } from "@/components/Toast";

// In-page camera: opens the device camera automatically (getUserMedia), shows a
// live viewfinder, and captures a still to a File. Falls back to a native file
// picker when the device has no camera or permission is denied. This replaces the
// <input type=file capture> that some browsers still show a file chooser for.
//
// onCapture(file: File | null) — called with the captured image, or null on retake
// (so the parent can clear its preview/state).

type Status = "starting" | "live" | "captured" | "denied" | "no-camera" | "fallback";

export default function FieldCamera({
  onCapture,
}: {
  onCapture: (file: File | null) => void;
}) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(
    async (mode: "environment" | "user") => {
      stopStream();
      setStatus("starting");
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("no-camera");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // required on iOS Safari
          videoRef.current.setAttribute("playsinline", "true");
          await videoRef.current.play().catch(() => {});
        }
        setStatus("live");
      } catch (err) {
        const e = err as DOMException;
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
          setStatus("denied");
        } else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
          // requested facingMode unavailable — try without the constraint
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            streamRef.current = stream;
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.setAttribute("playsinline", "true");
              await videoRef.current.play().catch(() => {});
            }
            setStatus("live");
          } catch {
            setStatus("no-camera");
          }
        } else {
          setStatus("no-camera");
        }
      }
    },
    [stopStream]
  );

  // Open the camera automatically on mount.
  useEffect(() => {
    startCamera(facing);
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // mirror front camera to match the viewfinder
    if (facing === "user") {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error("Capture failed");
          return;
        }
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        const url = URL.createObjectURL(file);
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
        onCapture(file);
        setStatus("captured");
        // stop the stream while previewing to save battery
        stopStream();
      },
      "image/jpeg",
      0.9
    );
  }

  function retake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    onCapture(null);
    startCamera(facing);
  }

  function switchCamera() {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    onCapture(null);
    startCamera(next);
  }

  function pickFallbackFile(file: File | null) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return url;
    });
    onCapture(file);
    setStatus("captured");
    stopStream();
  }

  // Fallback: no camera / permission denied → native file picker.
  if (status === "no-camera" || status === "denied" || status === "fallback") {
    return (
      <div className="space-y-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f) pickFallbackFile(f);
            }}
            required
            className="mt-1 block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-semibold"
          />
        </label>
        {status === "denied" && (
          <p className="text-xs text-amber-700">
            Camera permission was blocked. Enable it in your browser settings, or pick a
            file above.{" "}
            <button
              type="button"
              onClick={() => startCamera(facing)}
              className="text-blue-600 underline"
            >
              Try camera again
            </button>
          </p>
        )}
        {previewUrl && (
          <div className="relative aspect-square w-full max-w-xs rounded-lg overflow-hidden bg-gray-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <span className="text-sm font-medium text-gray-700 block">Photo</span>
      <div className="relative w-full aspect-[4/3] bg-black rounded-lg overflow-hidden">
        {/* live viewfinder */}
        <video
          ref={videoRef}
          muted
          playsInline
          className={`w-full h-full object-cover ${facing === "user" ? "scale-x-[-1]" : ""} ${
            status === "captured" ? "hidden" : ""
          }`}
        />
        {/* captured preview */}
        {previewUrl && status === "captured" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Captured" className="w-full h-full object-cover" />
        )}

        {/* starting overlay */}
        {status === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/80 gap-2">
            <Loader2 className="w-7 h-7 animate-spin" />
            <span className="text-xs">Opening camera…</span>
          </div>
        )}

        {/* top-right: switch camera (only while live) */}
        {status === "live" && (
          <button
            type="button"
            onClick={switchCamera}
            className="absolute top-2 right-2 bg-black/50 text-white p-2 rounded-full active:bg-black/70"
            title="Switch camera"
          >
            <SwitchCamera className="w-5 h-5" />
          </button>
        )}

        {/* capture / retake controls */}
        <div className="absolute bottom-0 left-0 right-0 p-3 flex items-center justify-center gap-4 bg-gradient-to-t from-black/60 to-transparent">
          {status === "live" ? (
            <button
              type="button"
              onClick={capture}
              className="w-16 h-16 rounded-full bg-white border-4 border-white/90 ring-4 ring-white/30 active:scale-95 flex items-center justify-center"
              title="Take photo"
            >
              <Camera className="w-7 h-7 text-gray-700" />
            </button>
          ) : status === "captured" ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={retake}
                className="flex items-center gap-1 bg-white/90 text-gray-900 px-4 py-2 rounded-full font-medium text-sm active:bg-white"
              >
                <RefreshCw className="w-4 h-4" /> Retake
              </button>
              <span className="flex items-center gap-1 text-white text-sm font-medium">
                <Check className="w-4 h-4" /> Ready
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* fallback link: let user pick a file instead */}
      <button
        type="button"
        onClick={() => setStatus("fallback")}
        className="inline-flex items-center gap-1 text-xs text-gray-500 active:text-gray-700"
      >
        <ImageIcon className="w-3.5 h-3.5" /> Choose a file instead
      </button>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}