"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

// Per-user desktop table density (STANDARD / COMPACT). Phase 1 of the desktop
// UI pass: persists the choice to localStorage and stamps `data-density` on
// <html>, which is what flips the `--row-py` / `--row-fs` tokens in globals.css
// — every shared DataTable picks the change up with no per-page wiring.
//
// Mobile is untouched by construction: the density tokens are only read by the
// desktop (hidden lg:block) table in DataTable, never by the mobile card list.
//
// The store is localStorage itself, read through useSyncExternalStore (no
// setState-in-effect dance): the server snapshot is "standard", the client
// snapshot re-reads the stored choice, and the click handler writes + notifies
// subscribers. Cross-tab changes arrive through the `storage` event for free.
//
// Wiring note: exported but not yet mounted anywhere — phase 3 mounts it in
// the desktop page header, deliberately after phase 2 has migrated tables.

const KEY = "tv-row-density";
type Density = "standard" | "compact";

// Subscribers are this component's own renders plus any future density
// consumer; module-level so the notify from a click reaches every mounted
// toggle and stays alive across unmount/remount of the header.
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): Density {
  try {
    return localStorage.getItem(KEY) === "compact" ? "compact" : "standard";
  } catch {
    // Storage blocked (private mode): session stays standard.
    return "standard";
  }
}

function getServerSnapshot(): Density {
  return "standard";
}

export default function DensityToggle({ className }: { className?: string }) {
  const density = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const write = useCallback((next: Density) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Session-only choice when storage is blocked.
    }
    listeners.forEach((l) => l());
  }, []);

  // Keep <html> stamped with the current choice — on first mount (deep link
  // with a stored compact setting, no click yet) and on every change. DOM-only
  // effect; no React state is touched.
  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
  }, [density]);

  const base =
    "px-2.5 py-1 text-[11px] font-mono tracking-wider uppercase transition-colors";
  const on = "bg-brand-bg text-brand-dark";
  const off = "text-muted hover:text-foreground";

  return (
    <div
      role="group"
      aria-label="Table row density"
      className={`inline-flex overflow-hidden rounded-lg border border-line ${className ?? ""}`}
    >
      <button
        type="button"
        onClick={() => write("standard")}
        aria-pressed={density === "standard"}
        className={`${base} ${density === "standard" ? on : off}`}
      >
        Standard
      </button>
      <button
        type="button"
        onClick={() => write("compact")}
        aria-pressed={density === "compact"}
        className={`${base} ${density === "compact" ? on : off}`}
      >
        Compact
      </button>
    </div>
  );
}