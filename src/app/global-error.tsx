"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { BRAND } from "@/lib/brand";

/**
 * Replaces the root layout entirely when the layout itself throws, so it
 * can't rely on globals.css / Tailwind being present. Uses inline styles only.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // INERT until NEXT_PUBLIC_SENTRY_DSN is set — captureException no-ops
    // without a DSN. Keeps console.error for local dev.
    Sentry.captureException(error);
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f9fafb",
          fontFamily: "system-ui, Arial, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "1rem", maxWidth: 360 }}>
          <h1 style={{ fontSize: 20, color: "#111827", marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 16 }}>
            The app hit an unexpected error. Please try again.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16 }}>
              Ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              background: BRAND.themeColor,
              color: "white",
              border: "none",
              padding: "10px 20px",
              borderRadius: 8,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}