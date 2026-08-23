import type { ReactNode } from "react";
import TopBar from "@/components/TopBar";

// Shared page shell. Collapses the wrapper copy-pasted into ~60 pages:
//   <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
//     <TopBar title subtitle backHref/>
//     <main className="max-w-md lg:max-w-{tier} mx-auto p-4 space-y-4">…</main>
//   </div>
// `pb-24 lg:pb-10` clears the mobile BottomNav (6rem on mobile, 2.5rem on
// desktop). maxWidth picks the desktop `lg:` cap; mobile is always max-w-md
// (28rem) — the one-column phone layout. Public/portal pages do NOT use this
// (they drop the chrome); see their own bare wrappers.

type MaxWidth = "form" | "list" | "wide" | "full";

const TIERS: Record<MaxWidth, string> = {
  form: "lg:max-w-2xl", // create/edit forms
  list: "lg:max-w-5xl", // most list + detail pages
  wide: "lg:max-w-6xl", // insights / reports
  full: "lg:max-w-7xl", // dashboard / gantt
};

export default function PageContainer({
  title,
  subtitle,
  backHref,
  backLabel,
  showSignOut,
  maxWidth = "list",
  mainClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  showSignOut?: boolean;
  maxWidth?: MaxWidth;
  // Extra classes on <main> (e.g. "space-y-6" instead of the default space-y-4).
  mainClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title={title}
        subtitle={subtitle}
        backHref={backHref}
        backLabel={backLabel}
        showSignOut={showSignOut}
      />
      <main
        className={`max-w-md ${TIERS[maxWidth]} mx-auto p-4 ${
          mainClassName ?? "space-y-4"
        }`}
      >
        {children}
      </main>
    </div>
  );
}