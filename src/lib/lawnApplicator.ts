// Applicator license eligibility — the compliance gate for lawn chemical
// applications (audit §4.1). A regulated application must not be logged under
// an applicator whose license is missing or expired: the CSV at
// /api/lawn/applications/export is the artifact a state regulator reads.
//
// Pure + deterministic so it runs identically in the server route (the gate)
// and in the office UI (the applicator badge in the Log drawer). `today` is
// injectable for tests; default is the current instant.
//
// Severity model (v1):
//   block  — no license on file, OR license expired. The route refuses the
//           application; the office reassigns to a licensed applicator.
//   warn  — license expires within LICENSE_WARN_DAYS. The route allows the
//           application; the badge surfaces it ahead of the date.
//   ok    — licensed and not expiring soon.
//
// A license number with no expiry date is a `warn` (we can't prove it's
// expired, but the record is incomplete and the office should fix it).

export const LICENSE_WARN_DAYS = 30;

export type ApplicatorSeverity = "ok" | "warn" | "block";

export type ApplicatorEligibility = {
  severity: ApplicatorSeverity;
  /** "" when ok; otherwise a single short sentence for toasts/badges/errors. */
  reason: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function checkApplicatorEligibility(input: {
  licenseNumber: string | null;
  /** ISO date or datetime string. Null = no expiry on file. */
  licenseExpires: string | null;
  /** ISO instant; defaults to now. Injected for tests. */
  today?: string;
}): ApplicatorEligibility {
  const today = new Date(input.today ?? new Date().toISOString());

  if (!input.licenseNumber || !input.licenseNumber.trim()) {
    return { severity: "block", reason: "No applicator license on file" };
  }

  if (!input.licenseExpires) {
    return {
      severity: "warn",
      reason: "License has no expiry date on file",
    };
  }

  const expires = new Date(input.licenseExpires);
  if (Number.isNaN(expires.getTime())) {
    return {
      severity: "warn",
      reason: "License expiry date is invalid",
    };
  }

  // Compare date-only so an expiry of 2026-03-01 is still valid on 2026-03-01
  // (treat end-of-day). Strip to midnight local.
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((day(expires) - day(today)) / 86_400_000);

  if (diffDays < 0) {
    return {
      severity: "block",
      reason: `Applicator license expired ${fmtDate(input.licenseExpires)}`,
    };
  }
  if (diffDays <= LICENSE_WARN_DAYS) {
    return {
      severity: "warn",
      reason: `License expires ${fmtDate(input.licenseExpires)}`,
    };
  }
  return { severity: "ok", reason: "" };
}