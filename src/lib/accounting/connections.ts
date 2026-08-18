// Per-org accounting connection persistence + token lifecycle.
// ----------------------------------------------------------------------------
// Wraps the `accounting_connections` table (RLS tier_office; service role for
// inserts from the OAuth callback). Owns token ENCRYPTION/DECRYPTION and the
// refresh-before-expiry loop: a caller asks for a usable TokenSet, we decrypt
// the stored row, refresh the access token if it's near expiry (persisting the
// rotated refresh token QBO returns), and hand back a DECRYPTED TokenSet ready
// to pass to an adapter. Adapters themselves stay stateless I/O (see
// ./provider.ts) — they never see the DB or the encryption key.
//
// Server-only. Imports the QuickBooks adapter so the provider registry is
// populated on first use. SQL/RLS/auth/security stay Claude-direct.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "./crypto";
import {
  type AccountingProviderId,
  type TokenSet,
  getProvider,
} from "./provider";

// Importing for the side effect of registering every accounting adapter in the
// provider registry (see ./providers.ts). Add new providers there.
import "./providers";

export type AccountingConnectionRow = {
  id: string;
  organization_id: string;
  provider: AccountingProviderId;
  status: string;
  realm_id: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  metadata: Record<string, unknown> | null;
};

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh if access token expires within 5 min

function parseIso(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Read the org's connection row for a provider (service role → bypasses RLS). */
export async function getConnection(
  organizationId: string,
  provider: AccountingProviderId
): Promise<AccountingConnectionRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("accounting_connections")
    .select(
      "id, organization_id, provider, status, realm_id, access_token_encrypted, refresh_token_encrypted, access_expires_at, refresh_expires_at, metadata"
    )
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountingConnectionRow | null) ?? null;
}

/** Encrypt + persist a freshly obtained/refreshed TokenSet for an org+provider. */
export async function saveTokens(
  organizationId: string,
  provider: AccountingProviderId,
  tokens: TokenSet,
  metadata?: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const accessEnc = tokens.accessToken ? encrypt(tokens.accessToken) : null;
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
  await admin
    .from("accounting_connections")
    .upsert(
      {
        organization_id: organizationId,
        provider,
        status: "active",
        realm_id: tokens.realmId ?? null,
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        access_expires_at: tokens.accessTokenExpiresAt ?? null,
        refresh_expires_at: tokens.refreshTokenExpiresAt ?? null,
        metadata: metadata ?? null,
      },
      { onConflict: "organization_id,provider" }
    );
}

/**
 * Return a DECRYPTED, ready-to-use TokenSet for the org+provider, refreshing
 * the access token first if it's near expiry. Persists any rotated tokens back
 * to the connection row. Throws if there is no active connection or the refresh
 * token itself has expired (caller should surface a "reconnect" prompt).
 */
export async function getUsableTokens(
  organizationId: string,
  provider: AccountingProviderId
): Promise<TokenSet> {
  const conn = await getConnection(organizationId, provider);
  if (!conn || conn.status !== "active" || !conn.refresh_token_encrypted) {
    throw new Error(`${provider} is not connected`);
  }

  const refreshToken = decrypt(conn.refresh_token_encrypted);
  const refreshExpiresAt = parseIso(conn.refresh_expires_at);
  if (refreshExpiresAt !== null && refreshExpiresAt <= Date.now()) {
    await setStatus(organizationId, provider, "expired");
    throw new Error(`${provider} refresh token has expired — reconnect`);
  }

  const accessExpiresAt = parseIso(conn.access_expires_at);
  const needsRefresh =
    !conn.access_token_encrypted ||
    accessExpiresAt === null ||
    accessExpiresAt <= Date.now() + REFRESH_MARGIN_MS;

  if (!needsRefresh) {
    return {
      accessToken: decrypt(conn.access_token_encrypted!),
      refreshToken,
      accessTokenExpiresAt: conn.access_expires_at,
      refreshTokenExpiresAt: conn.refresh_expires_at,
      realmId: conn.realm_id,
    };
  }

  // Refresh + persist the rotated tokens.
  const adapter = getProvider(provider);
  const refreshed = await adapter.refreshTokens(refreshToken);
  refreshed.realmId = conn.realm_id;
  await saveTokens(organizationId, provider, refreshed);
  return refreshed;
}

/** Update only the connection status (active/disconnected/expired). */
export async function setStatus(
  organizationId: string,
  provider: AccountingProviderId,
  status: "active" | "disconnected" | "expired"
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("accounting_connections")
    .update({ status })
    .eq("organization_id", organizationId)
    .eq("provider", provider);
}

/** Disconnect: clear tokens + mark the row disconnected (keeps the row for audit). */
export async function disconnect(
  organizationId: string,
  provider: AccountingProviderId
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("accounting_connections")
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      access_expires_at: null,
      refresh_expires_at: null,
    })
    .eq("organization_id", organizationId)
    .eq("provider", provider);
}

/** Mark a connection connected (called from the OAuth callback). Convenience. */
export async function markConnected(
  organizationId: string,
  provider: AccountingProviderId,
  tokens: TokenSet,
  metadata?: Record<string, unknown>
): Promise<void> {
  await saveTokens(organizationId, provider, tokens, metadata);
}

/** A pass-through Supabase client the adapter callbacks can use for any
 *  org-scoped reads they need (e.g. looking up a customer by id). */
export function serviceClient(): SupabaseClient {
  return createAdminClient();
}