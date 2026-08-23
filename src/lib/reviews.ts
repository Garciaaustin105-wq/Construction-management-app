// Shared contract for the lawn review-request rating gate (Track 1 of the
// lawn competitive roadmap). Consumed by the office inbox page + client list.
// The status route + /api/review-feedback write rows directly (service-role),
// so there is no server CRUD endpoint — office reads happen through RLS
// (tier_office_or_pm), mirroring leads.

export const REVIEW_STATUSES = ["sent", "opened", "happy", "unhappy"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// status lifecycle: sent → opened (page first resolved) → happy | unhappy
// (customer submitted a rating). `sent` with no `opened_at` = the email/SMS
// linked to /r/{token} but the customer hasn't opened it yet.
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  sent: "Sent",
  opened: "Opened",
  happy: "Happy",
  unhappy: "Unhappy",
};

// 4-5★ = happy (offered Google), 1-3★ = unhappy (internal feedback). Hardcoded
// for launch — move to a config if the threshold needs to vary per org.
export const HAPPY_THRESHOLD = 4;

export function isHappyRating(rating: number | null): boolean {
  return rating != null && rating >= HAPPY_THRESHOLD;
}

// Shape returned by the office inbox seed select (embeds the customer name via
// the review_requests.customer_id → customers FK — a LIVE FK once
// review_requests.sql is run, so PostgREST embed works).
export type ReviewRequest = {
  id: string;
  organization_id: string;
  customer_id: string | null;
  visit_id: string | null;
  channel: string;
  rating: number | null;
  feedback: string | null;
  status: string;
  created_at: string;
  opened_at: string | null;
  completed_at: string | null;
  customers: { name: string | null } | null;
};