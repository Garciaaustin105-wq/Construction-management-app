import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { isOfficeLike } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import EmailPreviewClient from "./EmailPreviewClient";

// Office/admin console to preview every customer-facing email EXACTLY as it
// ships, and send a test to your own inbox. Two categories: the 5 templated
// lawn visit-lifecycle events (editable — wording lives in
// notification_templates; this page edits AND saves them via
// /api/email-preview/save) and the fixed-copy estimate/invoice/etc emails
// (preview + test only — legal/accounting copy is code-owned).
//
// Auth: office/admin/super_admin (isOfficeLike). The server shell gates here;
// the client component is pure UI that talks to /api/email-preview (+test-send)
// and never touches Supabase directly. Available on BOTH variants — lawn has
// the 5 templated events, construction has estimate/invoice (and lawn has
// invoice via cycle billing), so this route is intentionally NOT in proxy.ts's
// lawn-blocked admin list.

export default async function EmailPreviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role ?? null;
  if (!isOfficeLike(role)) redirect("/dashboard");
  // super_admin has a null org → no org templates to save against; the client
  // disables the Save button and the /save route 400s on a null org anyway.
  const canSaveTemplates = !!profile?.organization_id;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Email Preview" backHref="/office" backLabel="Office" />
      <EmailPreviewClient canSaveTemplates={canSaveTemplates} />
    </div>
  );
}