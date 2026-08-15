import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BRAND } from "@/lib/brand";

// The app's root URL. A signed-in user who opens the site (e.g. a desktop
// browser pointed at "/") should land on their dashboard, not on the marketing
// sign-in page. The PWA manifest already sends mobile installs straight to
// /dashboard via start_url; this mirrors that for plain browser visits so
// desktop users aren't asked to sign in again every time they open the app.
export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

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