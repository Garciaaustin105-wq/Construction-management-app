"use client";

import { useEffect, useState } from "react";
import { FileText, Download, X, ExternalLink, Loader2 } from "lucide-react";

/**
 * Shows a blueprint document.
 * - Images render inline.
 * - PDFs: try direct iframe first; on load-error (mobile Safari, CORS, 404),
 *   swap to Google Docs viewer, then show a download fallback card.
 */
export default function BlueprintPreview({
  url,
  filename,
  onClose,
}: {
  url: string;
  filename: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"direct" | "gdocs" | "failed">("direct");
  const isPdf = /\.pdf(\?|$)/i.test(url) || /\.pdf$/i.test(filename);
  const isImage = /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(filename);

  // Lock body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Iframe load timer: if iframe never fires `load` in 8s for a PDF, fall back
  useEffect(() => {
    if (phase !== "direct" || !isPdf) return;
    const t = setTimeout(() => {
      setPhase((p) => (p === "direct" ? "gdocs" : p));
    }, 6000);
    return () => clearTimeout(t);
  }, [phase, isPdf]);

  const iframeSrc =
    phase === "gdocs" && isPdf
      ? `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`
      : url;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex flex-col"
      onClick={onClose}
    >
      <div className="flex items-center justify-between p-3 text-white">
        <span className="text-sm font-medium truncate min-w-0 flex-1">
          {filename}
        </span>
        <div className="flex items-center gap-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="p-2 hover:bg-white/10 rounded"
            title="Open in new tab"
          >
            <ExternalLink className="w-5 h-5" />
          </a>
          <a
            href={url}
            download={filename}
            onClick={(e) => e.stopPropagation()}
            className="p-2 hover:bg-white/10 rounded"
            title="Download"
          >
            <Download className="w-5 h-5" />
          </a>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-2 hover:bg-white/10 rounded"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 flex items-center justify-center p-2 min-h-0 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === "failed" ? (
          <div className="bg-white rounded-lg p-6 max-w-sm text-center">
            <FileText className="w-12 h-12 mx-auto text-gray-400 mb-3" />
            <p className="text-sm font-medium text-gray-900">
              Can&rsquo;t preview this file
            </p>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              The file might not be public yet. Make sure you ran the
              <code className="mx-1 px-1 bg-gray-100 rounded text-[11px]">
                blueprints_storage_fix.sql
              </code>
              script in Supabase.
            </p>
            <div className="flex gap-2 justify-center">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg"
              >
                Open
              </a>
              <a
                href={url}
                download={filename}
                className="px-4 py-2 bg-gray-200 text-gray-800 text-sm rounded-lg flex items-center gap-1"
              >
                <Download className="w-4 h-4" />
                Download
              </a>
            </div>
          </div>
        ) : isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={filename}
            className="max-w-full max-h-full object-contain min-w-0 min-h-0"
            onError={() => setPhase("failed")}
          />
        ) : (
          <>
            <iframe
              key={iframeSrc}
              src={iframeSrc}
              title={filename}
              sandbox=""
              className="w-full h-full bg-white rounded"
              onLoad={() => {
                // For PDFs, Google Docs returns its viewer page even for invalid URLs,
                // so we can't reliably detect success. The 6s timer handles the
                // direct-src case by escalating to gdocs.
              }}
              onError={() => {
                if (phase === "direct" && isPdf) setPhase("gdocs");
                else setPhase("failed");
              }}
            />
            {phase === "gdocs" && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/95 text-gray-800 rounded-full px-3 py-1.5 text-xs flex items-center gap-2 shadow">
                <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                Loading via Google viewer...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}