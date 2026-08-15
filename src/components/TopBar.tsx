"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { BRAND } from "@/lib/brand";
import { useOrgBranding } from "@/lib/useOrgBranding";
import OrgLogo from "@/components/OrgLogo";

export default function TopBar({
  title,
  subtitle,
  showSignOut = false,
  backHref,
  backLabel = "Back",
}: {
  title: string;
  subtitle?: string;
  showSignOut?: boolean;
  // When set, a back button is rendered in place of the logo — used on action
  // pages reached from a job (e.g. /crew/photo?job=…) so the user has an obvious
  // exit back to the job folder they came from, instead of only the bottom nav.
  backHref?: string;
  backLabel?: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const branding = useOrgBranding();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        {backHref ? (
          <Link
            href={backHref}
            className="flex items-center gap-0.5 text-blue-600 active:text-blue-700 flex-shrink-0 -ml-1 pr-1"
          >
            <ChevronLeft className="w-6 h-6" />
            <span className="text-sm font-semibold truncate max-w-[40vw]">
              {backLabel}
            </span>
          </Link>
        ) : (
          <OrgLogo
            logoUrl={branding.logoUrl}
            alt={BRAND.shortName}
            size={28}
          />
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-900 truncate">{title}</h1>
          {subtitle && (
            <p className="text-xs text-gray-500 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {showSignOut && (
        <button
          onClick={handleSignOut}
          className="text-xs text-gray-600 px-3 py-2 rounded hover:bg-gray-100 flex items-center gap-1"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      )}
    </header>
  );
}