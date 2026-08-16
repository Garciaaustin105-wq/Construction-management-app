"use client";

// Resolves the signed-in user's org branding (logo URL + org name) for app
// chrome (Sidebar + TopBar). White-label: when an org has uploaded a logo it is
// shown in place of the platform icon, and the org name replaces the platform
// short name.
//
// Implementation: a module-level store holds the current branding value plus the
// in-flight fetch promise, and consumers subscribe via useOrgBranding(). This
// design fixes two things a naive "cache the promise only" hook gets wrong:
//
//   1. No platform-default flash on navigation. TopBar is rendered per-page and
//      remounts on every route change; Sidebar is persistent. A hook that seeds
//      its state to EMPTY would paint the platform icon + "Terra Vista" name for
//      one frame on every TopBar remount before the (already-resolved) promise
//      updates it. Seeding from the store's current value instead means a
//      remount already has the real branding on its first paint.
//   2. Live update after a logo upload. invalidateOrgBranding() (called by
//      OrgSettingsForm after a PATCH) re-fetches and emits to every subscriber,
//      so even the persistent Sidebar updates without a reload.
//
// The store is reset on SIGNED_OUT so signing out as one tenant and back in as
// another (same browser tab, no hard reload) never flashes the previous org's
// logo/name.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type OrgBranding = {
  logoUrl: string | null;
  orgName: string | null;
};

const EMPTY: OrgBranding = { logoUrl: null, orgName: null };

// Module-level store. `_branding` is the current value (seeds new subscribers so
// they never flash the platform default after the first load); `_cache` dedups
// the fetch; `_listeners` receive live updates.
let _branding: OrgBranding = EMPTY;
let _cache: Promise<OrgBranding> | null = null;
const _listeners = new Set<(b: OrgBranding) => void>();
let _authWatched = false;

function emit() {
  for (const l of _listeners) l(_branding);
}

async function loadBranding(): Promise<OrgBranding> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .single();
  const orgId = (profile?.organization_id as string | null) ?? null;
  if (!orgId) return EMPTY;

  const { data: org } = await supabase
    .from("organizations")
    .select("name, logo_path")
    .eq("id", orgId)
    .maybeSingle();

  const logoPath = (org?.logo_path as string | null) ?? null;
  const logoUrl = logoPath
    ? supabase.storage.from("org-logos").getPublicUrl(logoPath).data.publicUrl
    : null;
  return { logoUrl, orgName: org?.name ?? null };
}

// Fetch (deduped by _cache), publish the result to the store + all subscribers.
async function refreshBranding(): Promise<OrgBranding> {
  const result = await loadBranding();
  _branding = result;
  emit();
  return result;
}

// One auth listener for the module lifetime: clears the store on sign-out so a
// different tenant signing in afterward never sees the previous org's brand.
function ensureAuthWatch() {
  if (_authWatched) return;
  _authWatched = true;
  const supabase = createClient();
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      _branding = EMPTY;
      _cache = null;
      emit();
    }
  });
}

// Drop the cache + re-fetch so a freshly uploaded logo/name propagates to every
// mounted chrome piece (Sidebar + TopBar) without a full reload. Called by
// OrgSettingsForm after a successful logo PATCH/DELETE.
export function invalidateOrgBranding() {
  _cache = refreshBranding();
}

export function useOrgBranding(): OrgBranding {
  // Seed from the store's current value so a remount (e.g. TopBar on each page)
  // already shows the real logo+name on its first paint — no Terra Vista flash.
  const [branding, setBranding] = useState<OrgBranding>(_branding);
  useEffect(() => {
    _listeners.add(setBranding);
    if (!_cache) _cache = refreshBranding();
    ensureAuthWatch();
    return () => {
      _listeners.delete(setBranding);
    };
  }, []);
  return branding;
}