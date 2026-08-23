"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

// Shared modal. Replaces the 7 hand-rolled `fixed inset-0` patterns with one
// consistent implementation:
//   - mobile-sheet → desktop-center: `items-end lg:items-center`, panel
//     `rounded-t-2xl lg:rounded-lg`, the BulkScheduleEditModal pattern.
//   - z-[100] everywhere (the viewers already used this; form modals used z-50
//     and could be occluded — unified now).
//   - body scroll-lock while open.
//   - Escape closes; backdrop click closes. Both skippable via onClose
//     omission (e.g. a viewer that only closes via its own X).
//   - `fullscreen` prop for the photo/blueprint/receipt lightbox family: full
//     black screen, panel grows to fill, no sheet rounding.

export default function Modal({
  open,
  onClose,
  children,
  fullscreen = false,
  panelClassName,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  fullscreen?: boolean;
  // Extra classes on the panel (e.g. a max-width). The default sheet/center
  // panel is lg:max-w-md; viewers pass their own.
  panelClassName?: string;
  closeOnBackdrop?: boolean;
}) {
  // Lock body scroll while open. Cleanup restores it; if another modal opens
  // on top, it re-locks harmlessly.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open || !onClose) return;
    const close = onClose;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const backdrop = fullscreen ? "bg-black" : "bg-black/40";
  const placement = fullscreen
    ? "items-stretch"
    : "items-end lg:items-center justify-center";
  const panel = fullscreen
    ? "w-full h-full"
    : "w-full lg:max-w-md rounded-t-2xl lg:rounded-lg max-h-[85vh] overflow-y-auto";

  return (
    <div
      className={`fixed inset-0 z-[100] ${backdrop} flex ${placement} p-0 lg:p-4`}
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        className={`bg-white ${panel} ${panelClassName ?? ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// Standard modal header with title + close X. Optional so callers that already
// render their own header (viewers) can skip it.
export function ModalHeader({
  title,
  onClose,
  className,
}: {
  title: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <div
      className={
        "flex items-center justify-between p-4 border-b border-line" +
        (className ? ` ${className}` : "")
      }
    >
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 p-1 hover:text-gray-600"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}