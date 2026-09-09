"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { BRAND } from "@/lib/brand";
import { useOrgBranding } from "@/lib/useOrgBranding";
import OrgLogo from "@/components/OrgLogo";
import { isLawn } from "@/lib/variant";

// Terra Verde chrome (lawn deploy only — construction keeps its original
// gray-* classes verbatim via the ternaries below; see Card.tsx precedent).
const TOPBAR_SHELL = isLawn() ? "bg-surface border-line-soft" : "bg-white border-gray-200";
const TOPBAR_TITLE = isLawn() ? "text-foreground" : "text-gray-900";
const TOPBAR_SUB = isLawn() ? "text-muted" : "text-gray-500";
const TOPBAR_SIGNOUT = isLawn()
  ? "text-muted-strong hover:bg-surface-muted"
  : "text-gray-600 hover:bg-gray-100";

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
    <header
      className={`sticky top-0 z-40 border-b px-4 py-3 flex items-center justify-between ${TOPBAR_SHELL}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {backHref ? (
          <Link
            href={backHref}
            className="flex items-center gap-0.5 text-brand active:text-brand-dark flex-shrink-0 -ml-1 pr-1"
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
            wordmarkFallback
          />
        )}
        <div className="min-w-0">
          <h1 className={`text-lg font-bold truncate ${TOPBAR_TITLE}`}>{title}</h1>
          {subtitle && (
            <p className={`text-xs truncate ${TOPBAR_SUB}`}>{subtitle}</p>
          )}
        </div>
      </div>
      {showSignOut && (
        <button
          onClick={handleSignOut}
          className={`text-xs px-3 py-2 rounded flex items-center gap-1 ${TOPBAR_SIGNOUT}`}
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      )}
    </header>
  );
}