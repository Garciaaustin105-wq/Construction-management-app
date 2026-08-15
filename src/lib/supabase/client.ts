import { createBrowserClient } from "@supabase/ssr";

// SINGLETON browser client. createBrowserClient must be constructed ONCE per
// browser session and reused — this is the documented Supabase pattern.
//
// Why a singleton (not a factory): each createBrowserClient() call builds a new
// SupabaseClient that asynchronously hydrates its auth session from cookies.
// A write fired on a fresh instance before hydration completes goes out
// UNAUTHENTICATED, so `to authenticated` RLS policies deny it — e.g. the
// intermittent "new row violates row-level security policy for table
// lawn_services" on a second service create (the page called createClient()
// fresh inside the handler, racing hydration). A module-level singleton
// hydrates once (on the first getUser/getSession call, typically in a page's
// mount effect) and shares the authenticated session across every caller,
// eliminating the race for all client components.

// Keep this as a separate helper so `ReturnType<typeof create>` captures the
// fully-instantiated SupabaseClient<Database> (with schema generics intact).
// Annotating with `ReturnType<typeof createBrowserClient>` directly would drop
// the generic parameters and widen query results to `any`.
function create() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

let _client: ReturnType<typeof create> | null = null;

export function createClient() {
  if (!_client) {
    _client = create();
  }
  return _client;
}