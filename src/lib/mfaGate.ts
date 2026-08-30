import type { SupabaseClient } from "@supabase/supabase-js";

// Shared by every place a sign-in can complete (password login, magic-link,
// the implicit-flow fragment handler in /login, and the PKCE /auth/callback
// route) so the "does this session still need an MFA step-up?" check can't
// drift between them. Cheap: getAuthenticatorAssuranceLevel() reads the
// current session's JWT claims locally -- no network call -- per Supabase's
// own docs.
//
// aal1 -> aal1: no factor enrolled, nothing to do.
// aal1 -> aal2: a verified TOTP factor exists but THIS session hasn't
//               stepped up yet -- send them to the challenge screen.
// aal2 -> aal2: already stepped up this session.
export async function needsMfaChallenge(
  supabase: SupabaseClient
): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === "aal2" && data.nextLevel !== data.currentLevel;
}
