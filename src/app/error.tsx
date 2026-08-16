"use client";

import { useEffect } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className="min-h-screen bg-gray-50 flex items-center justify-center px-4"
      role="alert"
    >
      <div className="max-w-sm w-full text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={BRAND.iconPath}
          alt={BRAND.shortName}
          width={56}
          height={56}
          className="mx-auto mb-4 rounded-xl"
        />
        <h1 className="text-xl font-bold text-gray-900 mb-1">
          Something went wrong
        </h1>
        <p className="text-sm text-gray-500">
          An unexpected error occurred while loading this page.
        </p>
        {error.digest && (
          <p className="text-xs text-gray-400 mt-2">Ref: {error.digest}</p>
        )}
        <div className="flex gap-2 justify-center mt-5">
          <button
            onClick={reset}
            className="bg-brand text-white px-5 py-2.5 rounded-lg font-semibold active:bg-brand-dark"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="px-5 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-semibold active:bg-gray-100"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}