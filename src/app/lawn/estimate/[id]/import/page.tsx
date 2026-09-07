// Bring a field measurement onto one estimate — Moasure, a GNSS rover, a drone
// or surveyor CSV. Spec: docs/handoff/handoff-site-import.md.
//
// A route rather than a step inside the map: the map component is Lane B's and
// already large, and an import is a deliberate office action rather than
// something done mid-draw.
//
// The role gate MATCHES the workspace it hangs off (/lawn/estimate/[id]): a
// server-side getMe() plus PIPELINE membership. Not stricter, not looser —
// anyone who can measure on that estimate can import a measurement into it.
// Every query is RLS-scoped to the caller's org; no manual filters.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { PIPELINE, type Role } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import SiteImportPanel from "@/components/SiteImportPanel";
import { loadImportTarget } from "@/lib/siteImportData";

export const dynamic = "force-dynamic";

export default async function SiteImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const me = await getMe();
  if (!me) redirect("/login");
  if (!PIPELINE.has(me.role as Role)) redirect("/dashboard");
  if (me.appVariant !== "lawn") redirect("/dashboard");

  const supabase = await createClient();
  // What is already measured, so the panel can state the disagreement rather
  // than quietly replacing it.
  const target = await loadImportTarget(supabase, id);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Import a measurement" subtitle="Estimate" />
      <main className="mx-auto max-w-md lg:max-w-5xl p-4">
        <header className="mb-4 space-y-3">
          {/* The way back. Without it this page is a dead end: it is reached
              from the workspace and everything it writes shows up there. */}
          <Link
            href={`/lawn/estimate/${id}`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to the measuring workspace
          </Link>
          <p className="text-sm text-gray-600">
            A file measured in the field, alongside what was drawn on the map.
            Both are kept — where they disagree, that difference is the most
            useful thing here, and it is yours to settle rather than the app&apos;s.
          </p>
        </header>

        {target.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {target.error}
          </div>
        ) : (
          <SiteImportPanel
            estimateId={id}
            orgId={me.orgId ?? ""}
            existingSqft={target.existingSqft}
          />
        )}
      </main>
    </div>
  );
}
