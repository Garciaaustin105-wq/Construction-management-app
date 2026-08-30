import { APP_URLS, APP_VARIANT } from "@/lib/variant";

// Single source of truth for facts shared by the Privacy Policy and Terms of
// Service pages, so the two documents can't drift out of sync on the entity
// name or contact address.

// The actual licensed operating entity — brand names (Terra Verde, Terra
// Vista Construction) are product names this LLC does business as, not
// separate legal entities. Update here if that ever changes.
export const LEGAL_ENTITY = "Terra Vista Building and Development LLC";

export const SUPPORT_EMAIL = `support@${new URL(APP_URLS[APP_VARIANT]).hostname}`;

// Bump this whenever either legal page's substantive content changes.
export const LEGAL_LAST_UPDATED = "August 29, 2026";
