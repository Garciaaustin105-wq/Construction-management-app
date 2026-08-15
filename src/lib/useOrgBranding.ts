"use client";

// Resolves the signed-in user's org branding (logo URL + org name) for app
// chrome (Sidebar/TopBar). White-label: when an org has uploaded a logo it is
// shown in place of the platform icon, and the org name replaces the platform
// short name.
//
// Module-level cache: both the Sidebar and TopBar mount on every authenticated
// page, so without dedup they'd each fire a profiles + organizations round-trip.
// The first caller kicks off loadBranding() and stores the promise; the second
// caller awaits the same one. invalidateOrgBranding() drops the cache so a
// freshly uploaded logo shows without a full page reload — OrgSettingsForm calls
// it after a successful logo PATCH.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type OrgBranding = {
  logoUrl: string | null;
  orgName: string | null;
};

const EMPTY: OrgBranding = { logoUrl: null, orgName: null };

let _cache: Promise<OrgBranding> | null = null;

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

// Drop the cache so the next mount re-fetches. Call after a logo upload/remove.
export function invalidateOrgBranding() {
  _cache = null;
}

export function useOrgBranding(): OrgBranding {
  const [branding, setBranding] = useState<OrgBranding>(EMPTY);
  useEffect(() => {
    if (!_cache) _cache = loadBranding();
    let active = true;
    _cache
      .then((b) => {
        if (active) setBranding(b);
      })
      .catch(() => {
        // Non-fatal: chrome just falls back to the platform icon.
        if (active) setBranding(EMPTY);
      });
    return () => {
      active = false;
    };
  }, []);
  return branding;
}