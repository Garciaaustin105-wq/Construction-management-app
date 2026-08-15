import Link from "next/link";
import { BRAND } from "@/lib/brand";

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/terra-vista-logo.svg"
          alt={BRAND.company}
          width={300}
          height={83}
          className="mx-auto mb-4"
        />
        <p className="text-gray-600 mb-8">
          {BRAND.tagline}.
        </p>
        <Link
          href="/login"
          className="inline-block bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
        >
          Sign In
        </Link>
      </div>
    </main>
  );
}
