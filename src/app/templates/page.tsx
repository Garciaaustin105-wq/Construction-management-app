import { redirect } from "next/navigation";

// Templates moved from its own top-level nav tab into a view on the
// Estimates page (/estimates?tab=templates) — it was never a distinct
// top-level concept, just a management screen for something the estimate
// editor already fully handles inline (load/save-as-template). This shim
// keeps old links/bookmarks/nav entries (e.g. the construction desktop
// nav's "Templates" tab) working. See src/app/estimates/page.tsx.
export const dynamic = "force-dynamic";

export default function EstimateTemplatesRedirect() {
  redirect("/estimates?tab=templates");
}