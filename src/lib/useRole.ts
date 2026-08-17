"use client";

// Resolves the signed-in user's role for app chrome (Sidebar + BottomNav) and
// any client component that role-gates UI. Mirrors [[useOrgBranding]] exactly —
// same module-level store pattern — to fix the role-gated-tab flash.
//
// The bug this fixes: Sidebar/BottomNav held `role` in `useState(null)` and
// fetched it in a `useEffect`. On any (re)mount, `role` painted as `null` first,
// so admin-only / super_admin-only nav items (Billing, Platform) were absent for
// one frame and then popped in once the profile resolved -> a visible flash of
// the Billing tab while clicking through nav. Seeding each subscriber from the
// store's CURRENT value means a remount already has the real role on its first
// paint (after the first load), eliminating the flash — same approach the
// branding store takes for the TopBar logo/name.
//
// `_role` is the current value (seeds new subscribers so they never flash the
// null/base nav after the first load); `_cache` dedups the fetch; `_listeners`
// receive live updates. The store is reset on SIGNED_OUT so a different user
// signing in afterward (same tab, no hard reload) never sees the previous role.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/roles";

let _role: Role | null = null;
let _cache: Promise<Role | null> | null = null;
const _listeners = new Set<(r: Role | null) => void>();
let _authWatched = false;

function emit() {
  for (const l of _listeners) l(_role);
}

async function loadRole(): Promise<Role | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return (data?.role as Role) ?? null;
}

async function refreshRole(): Promise<Role | null> {
  const result = await loadRole();
  _role = result;
  emit();
  return result;
}

// One auth listener for the module lifetime: clears the store on sign-out so a
// different user signing in afterward never sees the previous role's nav.
function ensureAuthWatch() {
  if (_authWatched) return;
  _authWatched = true;
  const supabase = createClient();
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      _role = null;
      _cache = null;
      emit();
    }
  });
}

// Drop the cache + re-fetch so a role change (e.g. an admin demotes a user in
// another tab) propagates to every mounted chrome piece without a full reload.
export function invalidateRole() {
  _cache = refreshRole();
}

export function useRole(): Role | null {
  // Seed from the store's current value so a remount already has the real role
  // on its first paint — no Billing/Platform flash after the first load.
  const [role, setRole] = useState<Role | null>(_role);
  useEffect(() => {
    _listeners.add(setRole);
    if (!_cache) _cache = refreshRole();
    ensureAuthWatch();
    return () => {
      _listeners.delete(setRole);
    };
  }, []);
  return role;
}