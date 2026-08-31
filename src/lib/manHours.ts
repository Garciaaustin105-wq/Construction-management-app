// Pricing maths for lawn work. Pure: no clock, no I/O, no mutation.
//
// The whole module exists because labour is priced in MAN-HOURS, not clock
// time. A 4-person crew on site for 20 minutes produced 1.33 man-hours, not
// 0.33 — so a pricing model built on duration alone under-quotes every job by
// the size of the crew. Crew size is not a refinement here; without it a
// duration cannot become a price at all.
//
// Industry reference point: ~0.2 man-hours per 1,000 sqft for standard mowing,
// billed at $65-145 per man-hour. That is ~12 man-minutes per 1,000 sqft, which
// is what the defaults below are scaled around.

export type MeasurementFlag = null | "too_long" | "too_short" | "no_departure";

export type Measurement = {
  visitId: string;
  /** Milliseconds on site. null means the crew never departed. */
  onSiteMs: number | null;
  /** People on the truck, including those with no phone. */
  crewSize: number;
  /** Lot area. null or 0 means unknown. */
  lotSqft: number | null;
};

export type BaselineOptions = {
  /** Below this many minutes on site, the reading is too_short. Default 4. */
  minOnSiteMinutes?: number;
  /** Above this many man-minutes per 1000 sqft, too_long. Default 60. */
  maxManMinutesPer1000?: number;
};

export type Baseline = {
  /** Median man-minutes per 1000 sqft across the INCLUDED rows. 0 when n is 0. */
  medianManMinutesPer1000: number;
  /** How many measurements were included. */
  n: number;
  /** Every measurement that was excluded, with the reason. */
  excluded: { visitId: string; flag: MeasurementFlag }[];
};

export const BASELINE_DEFAULTS: Required<BaselineOptions> = {
  // Parking on the wrong street for a phone call must not become a data point.
  minOnSiteMinutes: 4,
  // ~5x the industry figure. Generous on purpose: the goal is to catch a crew
  // that broke for lunch on site, not to second-guess a genuinely hard lot.
  maxManMinutesPer1000: 60,
};

/** Duration times heads. The multiplication IS the point of this module. */
export function manHours(onSiteMs: number, crewSize: number): number {
  if (onSiteMs <= 0 || crewSize <= 0) return 0;
  return (onSiteMs / 3_600_000) * crewSize;
}

/** The rate the estimator actually prices from: labour per unit of area. */
export function manMinutesPer1000Sqft(
  onSiteMs: number,
  crewSize: number,
  lotSqft: number
): number {
  if (lotSqft <= 0 || onSiteMs <= 0 || crewSize <= 0) return 0;
  return (manHours(onSiteMs, crewSize) * 60) / (lotSqft / 1000);
}

/**
 * Why a reading should be kept out of the pricing baseline.
 *
 * Note what is NOT flagged: a missing lot size or crew size returns null, not
 * an outlier. Those rows are unusable, not suspicious — the crew did nothing
 * unusual, we simply never measured the property or never asked the lead how
 * many people were on the truck. Calling that "too_long" would blame the crew
 * for our own missing data, and would pollute any report that counts flags.
 * buildBaseline still excludes them; it just does so without an accusation.
 */
export function classifyMeasurement(
  m: Measurement,
  options?: BaselineOptions
): MeasurementFlag {
  const opts = { ...BASELINE_DEFAULTS, ...options };
  if (m.onSiteMs === null) return "no_departure";
  if (m.onSiteMs < opts.minOnSiteMinutes * 60_000) return "too_short";
  if (m.lotSqft === null || m.lotSqft <= 0) return null;
  if (m.crewSize <= 0) return null;
  if (
    manMinutesPer1000Sqft(m.onSiteMs, m.crewSize, m.lotSqft) >
    opts.maxManMinutesPer1000
  ) {
    return "too_long";
  }
  return null;
}

/** Sorts a COPY — callers pass arrays they still need. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

/** Coarse buckets, because a 4,000 sqft lot and a half-acre are different jobs. */
export function lotSizeBand(sqft: number): string {
  if (sqft <= 0) return "unknown";
  if (sqft < 5000) return "under-5k";
  if (sqft < 10000) return "5k-10k";
  if (sqft < 20000) return "10k-20k";
  if (sqft < 43560) return "20k-1acre";
  return "1acre-plus";
}

/**
 * The baseline rate, as a MEDIAN rather than a mean.
 *
 * This is the single most important choice in the file. GPS cannot tell a
 * stationary mower operator from a stationary sandwich, so some readings will
 * silently include a lunch break taken on the property. A mean lets one
 * two-hour lunch drag the whole figure — and every quote built on it — upward.
 * A median barely moves. That robustness is what lets the rest of the system
 * avoid trying to DETECT slacking, which would mean accusing a crew based on a
 * phone, and would end with the phone left in the truck and no data at all.
 */
export function buildBaseline(
  measurements: Measurement[],
  options?: BaselineOptions
): Baseline {
  const opts = { ...BASELINE_DEFAULTS, ...options };
  const included: number[] = [];
  const excluded: { visitId: string; flag: MeasurementFlag }[] = [];

  for (const m of measurements) {
    const flag = classifyMeasurement(m, opts);
    // Narrowed rather than asserted: a null flag already proves onSiteMs is
    // non-null (it would have been "no_departure"), but stating the checks
    // keeps that reasoning local instead of hiding it behind a `!`.
    const { onSiteMs, lotSqft, crewSize } = m;
    if (
      flag !== null ||
      onSiteMs === null ||
      lotSqft === null ||
      lotSqft <= 0 ||
      crewSize <= 0
    ) {
      excluded.push({ visitId: m.visitId, flag });
      continue;
    }
    included.push(manMinutesPer1000Sqft(onSiteMs, crewSize, lotSqft));
  }

  return {
    medianManMinutesPer1000: median(included),
    n: included.length,
    excluded,
  };
}
