"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Plus, ChevronDown } from "lucide-react";

export default function EstimatesNewMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className="rounded-lg bg-blue-600 text-white text-sm font-semibold px-3 py-1.5 flex items-center gap-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="w-4 h-4" />
        New estimate
        <ChevronDown
          className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-lg border border-gray-200 bg-white shadow-lg z-20">
          <Link
            href="/estimates/quick"
            className="block px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
            onClick={() => setOpen(false)}
          >
            <p className="text-sm font-semibold text-gray-900">Quick quote</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Measure the yard and price it on the spot — best for a new prospect in the field.
            </p>
          </Link>
          <Link
            href="/estimates/new"
            className="block px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
            onClick={() => setOpen(false)}
          >
            <p className="text-sm font-semibold text-gray-900">Detailed estimate</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Job-linked, cost-coded line items with recurring schedules — best for a fully priced office estimate.
            </p>
          </Link>
        </div>
      )}
    </div>
  );
}
