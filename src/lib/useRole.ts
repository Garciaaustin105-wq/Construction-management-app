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
// The COLD-LOAD flash remained even with the store: on the very first paint
// `_role` is still null, so the chrome painted the null-role fallback nav for
// one frame (desktop: full office sidebar; mobile: flat base bar) before the
// profile fetch resolved. The root layout now reads the profile SERVER-side and
// seeds it via `RoleSeedProvider`, so `useRole`'s first paint already has the
// real role. The store still drives live updates (invalidateRole, sign-out) and
// is the fallback when no seed is present.
//
// `_role` is the current value (seeds new subscribers so they never flash the
// null/base nav after the first load); `_cache` dedups the fetch; `_listeners`
// receive live updates. The store is reset on SIGNED_OUT so a different user
// signing in afterward (same tab, no hard reload) never sees the previous role.

import { createContext, createElement, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/roles";

// Server-seeded initial role (from the root layout's profile read). `undefined`
// means "no provider above this component" → fall back to the module store.
const RoleSeedContext = createContext<Role | null | undefined>(undefined);

// Wraps the app in the root layout so every useRole() subscriber paints with
// the server-known role on its FIRST client frame — no cold-load nav flash.
// (createElement, not JSX, because this module is .ts — imported everywhere as
// `@/lib/useRole` — so it can't be renamed to .tsx without churning callers.)
export function RoleSeedProvider({
  value,
  children,
}: {
  value: Role | null;
  children: ReactNode;
}) {
  return createElement(RoleSeedContext.Provider, { value }, children);
}

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
  // Prefer the module store's current value (warm remounts / live updates),
  // then the server-seeded role (cold first load), then null. On a cold load
  // _role is null so the server seed wins → the first paint has the real role
  // and the chrome never flashes the null-role fallback nav.
  const seed = useContext(RoleSeedContext);
  const [role, setRole] = useState<Role | null>(
    _role ?? (seed ?? null),
  );
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