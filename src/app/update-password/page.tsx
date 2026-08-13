import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import UpdatePasswordForm from "./UpdatePasswordForm";

// The "set a new password" landing page. Reached only via the recovery flow:
// /auth/callback exchanges the recovery code (establishing a session) and
// redirects here. We require an active session — a direct visit with no session
// means the user didn't arrive from a valid reset link, so bounce to /login.
export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <UpdatePasswordForm />
    </main>
  );
}