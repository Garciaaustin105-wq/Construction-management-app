"use client";

// Resolves whether the signed-in user's org has the hidden ISP / fiber module
// turned on (`organizations.isp_module_enabled`). Consumed by the app chrome
// (Sidebar + BottomNav) so the Installs tab only appears for the one org that
// has it — every other tenant's nav is byte-identical to before.
//
// Mirrors [[useOrgBranding]] / [[useRole]] exactly — same module-level store
// pattern — for the same reason: the chrome remounts on every route change, and
// a hook seeded to `false` would paint the nav WITHOUT the Installs tab for one
// frame and then pop it in. Seeding new subscribers from the store's current
// value means a remount already has the real value on its first paint.
//
// `_enabled` is the current value; `_cache` dedups the fetch; `_listeners`
// receive live updates. The store is reset on SIGNED_OUT so a different user
// signing in afterward (same tab, no hard reload) never inherits the previous
// org's module state.
//
// SECURITY NOTE: this gates UI REACHABILITY only. It is deliberately NOT the
// access control — RLS on installs / install_types / install_time_entries /
// install_issues / install_notes / install_materials is what actually protects
// the data, and it does not reference this flag. A user in an org without the
// module who hand-types /installs sees an empty list (RLS returns nothing) and
// the page redirects them out; they never get data. Keeping the flag out of RLS
// means flipping it can never become a data leak.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

let _enabled = false;
let _cache: Promise<boolean> | null = null;
const _listeners = new Set<(v: boolean) => void>();
let _authWatched = false;

function emit() {
  for (const l of _listeners) l(_enabled);
}

async function loadIspModule(): Promise<boolean> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .single();
  const orgId = (profile?.organization_id as string | null) ?? null;
  if (!orgId) return false;

  const { data: org } = await supabase
    .from("organizations")
    .select("isp_module_enabled")
    .eq("id", orgId)
    .maybeSingle();

  // `?? false` also covers the window before isp_module.sql has been run, when
  // the column doesn't exist yet and the select errors — the nav simply stays
  // as it is today rather than throwing.
  return (org?.isp_module_enabled as boolean | null) ?? false;
}

async function refreshIspModule(): Promise<boolean> {
  const result = await loadIspModule();
  _enabled = result;
  emit();
  return result;
}

// One auth listener for the module lifetime: clears the store on sign-out.
function ensureAuthWatch() {
  if (_authWatched) return;
  _authWatched = true;
  const supabase = createClient();
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      _enabled = false;
      _cache = null;
      emit();
    }
  });
}

export function useIspModule(): boolean {
  const [enabled, setEnabled] = useState<boolean>(_enabled);

  useEffect(() => {
    ensureAuthWatch();
    _listeners.add(setEnabled);
    if (!_cache) _cache = refreshIspModule();
    _cache.then((v) => setEnabled(v)).catch(() => setEnabled(false));
    return () => {
      _listeners.delete(setEnabled);
    };
  }, []);

  return enabled;
}
