"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/**
 * Wraps children with a pull-to-refresh gesture. On pull-down past the threshold
 * and release, calls router.refresh() to refetch server data.
 *
 * Intended for top-level pages where vertical scroll starts at the top.
 */
export default function PullToRefresh({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);

  const THRESHOLD = 80;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      // Only start if scrolled to top
      if ((el?.scrollTop ?? 0) > 0) return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!pulling.current || startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0) {
        e.preventDefault();
        // Damped pull distance
        setPull(Math.min(dy * 0.4, THRESHOLD + 30));
      } else {
        setPull(0);
        pulling.current = false;
      }
    }

    function onTouchEnd() {
      if (!pulling.current) return;
      pulling.current = false;
      if (pull >= THRESHOLD) {
        setRefreshing(true);
        setPull(THRESHOLD);
        router.refresh();
        setTimeout(() => {
          setRefreshing(false);
          setPull(0);
        }, 800);
      } else {
        setPull(0);
      }
      startY.current = null;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [pull, router]);

  return (
    <div ref={ref} className={className}>
      {pull > 0 && (
        <div
          className="flex items-center justify-center text-blue-600 transition-opacity"
          style={{
            height: pull,
            opacity: Math.min(pull / THRESHOLD, 1),
          }}
        >
          <RefreshCw
            className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`}
            style={{
              transform: `rotate(${Math.min((pull / THRESHOLD) * 360, 360)}deg)`,
            }}
          />
        </div>
      )}
      {children}
    </div>
  );
}