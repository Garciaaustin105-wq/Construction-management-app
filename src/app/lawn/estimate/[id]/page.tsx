// Lawn estimating workspace — the full-width measuring-and-pricing surface
// for one estimate (map + line-item strip). The document side (customer,
// terms, sending, PDF, email preview) stays on /estimates/[id]; this page
// hands back to it.
//
// The role gate here MATCHES the /estimates list page exactly (the gate the
// sales pipeline reaches quick quotes through): a server-side getMe() +
// PIPELINE membership check that redirects. Not stricter, not looser — a
// sales rep who can open /estimates/[id] today can open this workspace.

import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { PIPELINE, type Role } from "@/lib/roles";
import LawnEstimateWorkspace from "@/components/LawnEstimateWorkspace";

export default async function LawnEstimateWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const me = await getMe();
  if (!me) redirect("/login");
  // Same admission set as /estimates (sales + PM + office + admin +
  // super_admin). Every query the workspace makes is RLS-scoped to the
  // caller's org — no manual filters.
  if (!PIPELINE.has(me.role as Role)) redirect("/dashboard");

  return <LawnEstimateWorkspace estimateId={id} />;
}