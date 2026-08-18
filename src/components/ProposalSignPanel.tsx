"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Loader2, PenLine, RotateCcw, ShieldCheck } from "lucide-react";

// E-signature capture for an authed Client Portal customer signing a proposal.
// Full widget per the locked decision: the client TYPES their legal name AND
// draws a signature on a canvas. Both are submitted to
// /api/proposals/[id]/sign, which uploads the drawn PNG, runs the
// sign_proposal RPC (ownership + same_org + status guarded server-side),
// generates the signed PDF, creates the invoice, and notifies the office.
//
// The typed name doubles as the recorded signer name + the legal "I agree"
// attestation. The drawn signature is the graphical artifact embedded in the
// signed PDF. A blank name OR a blank drawing blocks Sign (both are required
// for a defensible e-signature — a name with no mark, or a mark with no name,
// are each weak on their own).

type Point = { x: number; y: number };

export default function ProposalSignPanel({ estimateId }: { estimateId: string }) {
  const router = useRouter();
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Tracks whether the customer has drawn anything. A pristine canvas (no
  // strokes) should block Sign even though toDataURL would happily return a
  // blank PNG.
  const [hasDrawn, setHasDrawn] = useState(false);
  const [signatureText, setSignatureText] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  // In-progress stroke state (refs, not state — drawing doesn't need renders).
  const drawing = useRef(false);
  const lastPoint = useRef<Point | null>(null);

  // High-DPI canvas setup: size the backing store to CSS size × devicePixelRatio
  // so the signature is crisp, then scale the context so drawing uses CSS
  // coordinates. Re-runs on resize so a rotated phone re-rasters cleanly.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      // Preserve any existing drawing across a re-raster (e.g. orientation
      // change): snapshot → resize → redraw.
      const snapshot =
        hasDrawn && canvas.width > 0
          ? canvas.toDataURL("image/png")
          : null;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#111827"; // gray-900
      if (snapshot) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, w, h);
        img.src = snapshot;
      }
    };
    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawing.current = true;
    lastPoint.current = pointFromEvent(e);
    // A dot for a tap (no move) so a single touch still leaves a mark.
    const ctx = canvas.getContext("2d");
    if (ctx && lastPoint.current) {
      ctx.beginPath();
      ctx.arc(lastPoint.current.x, lastPoint.current.y, 1.25, 0, Math.PI * 2);
      ctx.fillStyle = "#111827";
      ctx.fill();
    }
    if (!hasDrawn) setHasDrawn(true);
  }

  function moveStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const from = lastPoint.current;
    const to = pointFromEvent(e);
    if (!ctx || !from) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    lastPoint.current = to;
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture throws if the pointer was never captured
      // (e.g. pointerup outside the canvas). Harmless.
    }
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  }

  async function sign() {
    const name = signatureText.trim();
    if (!name) {
      toast.warning("Type your full legal name to sign.");
      return;
    }
    if (!hasDrawn) {
      toast.warning("Draw your signature in the box above.");
      return;
    }
    if (!agreed) {
      toast.warning("Check the box to confirm you agree to the terms.");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A truly blank canvas (no strokes but hasDrawn stayed true somehow)
    // still shouldn't ship — sample a few pixels.
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hasInk = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) {
          hasInk = true;
          break;
        }
      }
      if (!hasInk) {
        toast.warning("Draw your signature in the box above.");
        return;
      }
    }
    const signatureImageDataUrl = canvas.toDataURL("image/png");
    // Send the canvas backing-store dimensions so the server can size the
    // signature image in the PDF without stretching it (aspect preserved).
    setBusy(true);
    try {
      const res = await fetch(`/api/proposals/${estimateId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signatureText: name,
          signatureImageDataUrl,
          signatureWidth: canvas.width,
          signatureHeight: canvas.height,
          signerName: name,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Sign failed (${res.status})`);
        setBusy(false);
        return;
      }
      toast.success("Proposal signed — an invoice is on its way to you.");
      router.push("/customer?signed=1");
    } catch {
      toast.error("Sign failed — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-semibold text-gray-700">
          Type your full legal name
        </span>
        <input
          type="text"
          value={signatureText}
          onChange={(e) => setSignatureText(e.target.value)}
          placeholder="First and last name"
          autoComplete="name"
          className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-gray-700">
            Draw your signature
          </span>
          <button
            type="button"
            onClick={clearSignature}
            disabled={!hasDrawn}
            className="text-xs text-blue-600 flex items-center gap-1 disabled:opacity-40"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
        <canvas
          ref={canvasRef}
          onPointerDown={startStroke}
          onPointerMove={moveStroke}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
          className="w-full h-40 bg-white border-2 border-gray-300 rounded-lg touch-none cursor-crosshair"
          style={{ touchAction: "none" }}
        />
        <p className="text-xs text-gray-400 mt-1">
          Draw with your finger or mouse. Your typed name + this signature are
          recorded with the date and your IP.
        </p>
      </div>

      <label className="flex items-start gap-2.5 bg-gray-50 rounded-lg p-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="w-5 h-5 mt-0.5 flex-shrink-0"
        />
        <span className="text-sm text-gray-700">
          I agree to the terms and pricing in this proposal. My typed name and
          drawn signature constitute my electronic signature, legally binding to
          the same extent as a handwritten signature.
        </span>
      </label>

      <button
        onClick={sign}
        disabled={busy}
        className="w-full bg-green-600 text-white py-4 rounded-xl font-semibold text-lg active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <ShieldCheck className="w-5 h-5" />
        )}
        {busy ? "Signing…" : "Sign Proposal"}
      </button>
      <p className="text-xs text-gray-400 text-center flex items-center justify-center gap-1">
        <PenLine className="w-3 h-3" />
        A signed copy + your invoice will be emailed to you.
      </p>
    </div>
  );
}