import Link from "next/link";
import { BRAND } from "@/lib/brand";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/terra-vista-icon.svg"
          alt={BRAND.shortName}
          width={56}
          height={56}
          className="mx-auto mb-4 rounded-xl"
        />
        <h1 className="text-xl font-bold text-gray-900 mb-1">
          We couldn&rsquo;t find that page
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          The job, invoice, or page you&rsquo;re looking for may have been
          removed or never existed.
        </p>
        <Link
          href="/dashboard"
          className="inline-block bg-blue-600 text-white px-6 py-2.5 rounded-lg font-semibold active:bg-blue-700"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}