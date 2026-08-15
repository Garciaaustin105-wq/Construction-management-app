import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role (admin) Supabase client — bypasses RLS. Use ONLY in server
// routes / webhooks for privileged writes: creating auth users, syncing Stripe
// webhook events, etc. Never import this (or read SUPABASE_SERVICE_ROLE_KEY)
// from client code. Factored out of the inline pattern that was duplicated
// across ~14 routes.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}