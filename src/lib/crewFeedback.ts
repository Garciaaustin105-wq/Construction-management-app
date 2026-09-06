import { manHours as manHoursFrom, median } from "./manHours";

/**
 * Reads actual crew time back against what was estimated, so an org can replace
 * borrowed production rates with its own.
 *
 * WHY THIS EXISTS: every published source on landscape estimating says the same
 * thing — do not borrow production rates, time your own installs and log each
 * task separately. A 20% labor error is the difference between a profitable
 * contract and a break-even one. The app already collects the time; nothing
 * read it back. See docs/labor-production-rates.md.
 *
 * THIS FILE SUGGESTS. IT NEVER WRITES. Every function here returns a proposal
 * with its sample size and spread attached, and a human presses the button.
 * That is the same rule the catalogues follow: values belong to the org.
 *
 * It also never grades a crew. Like src/lib/manHours.ts, this reports a
 * measurement and refuses to draw a conclusion about why a job ran long —
 * weather, access, soil and a broken machine all look identical from here, and
 * an app that accuses a crew based on a phone ends up with the phone left in
 * the truck and no data at all.
 */

/* ── Time entries ─────────────────────────────────────────────────────────── */

/**
 * Why an entry cannot be used.
 *
 * `no_crew_size` is the one that matters. Man-hours are duration TIMES heads,
 * so an entry without a crew size cannot become man-hours at all — a 3-person
 * crew for 8 hours is 24 man-hours, not 8. Defaulting the crew to 1 would
 * understate every rate by the size of the crew and would look completely
 * normal on screen. The entry is excluded and counted instead, so the screen
 * can say what is missing rather than quietly producing a third of the truth.
 */
export type EntryFlag = null | "open" | "no_crew_size" | "invalid_window";

export type ClockEntry = {
  id: string;
  jobId: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  crewSize: number | null;
};

function msBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const start = Date.parse(a);
  const end = Date.parse(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

export function classifyEntry(e: ClockEntry): EntryFlag {
  if (!e.clockOutAt) return "open";
  const ms = msBetween(e.clockInAt, e.clockOutAt);
  if (ms === null || ms <= 0) return "invalid_window";
  // Checked AFTER the window, so a still-running entry reads as open rather
  // than as missing data the office needs to go and fix.
  if (typeof e.crewSize !== "number" || !Number.isFinite(e.crewSize) || e.crewSize <= 0) {
    return "no_crew_size";
  }
  return null;
}

/** Man-hours for one entry, or null when it cannot be used. Never guesses. */
export function entryManHours(e: ClockEntry): number | null {
  if (classifyEntry(e) !== null) return null;
  const ms = msBetween(e.clockInAt, e.clockOutAt);
  if (ms === null) return null;
  return manHoursFrom(ms, e.crewSize as number);
}

export type ActualTime = {
  manHours: number;
  /** Entries that contributed. */
  included: number;
  excluded: { id: string; flag: EntryFlag }[];
  /** Broken out because it is the fixable one, and usually the big one. */
  noCrewSizeCount: number;
  openCount: number;
};

export function actualManHours(entries: ClockEntry[]): ActualTime {
  let total = 0;
  let included = 0;
  const excluded: { id: string; flag: EntryFlag }[] = [];
  let noCrewSizeCount = 0;
  let openCount = 0;

  for (const e of entries) {
    const flag = classifyEntry(e);
    if (flag !== null) {
      excluded.push({ id: e.id, flag });
      if (flag === "no_crew_size") noCrewSizeCount += 1;
      if (flag === "open") openCount += 1;
      continue;
    }
    const h = entryManHours(e);
    if (h === null) continue;
    total += h;
    included += 1;
  }

  return {
    manHours: Math.round(total * 100) / 100,
    included,
    excluded,
    noCrewSizeCount,
    openCount,
  };
}

/* ── One job ──────────────────────────────────────────────────────────────── */

/**
 * A billable line on the estimate, flattened out of whichever catalogue it came
 * from. `key` is what observations are grouped by, so it must identify the
 * catalogue ROW — a plant size, a component, a labor item — and not just its
 * category.
 */
export type EstimateTaskLine = {
  key: string;
  label: string;
  unit: string;
  quantity: number;
  /** As ESTIMATED, from the catalogue rate at the time. May be 0 if unrated. */
  manHours: number;
};

export type JobRecord = {
  jobId: string;
  estimateId: string;
  jobName: string;
  completedAt: string | null;
  lines: EstimateTaskLine[];
  entries: ClockEntry[];
  /**
   * Estimated drive-out, unload, set-up, clean-up and drive-back. It is real
   * labor, it is inside the clocked time, and it belongs to NO item — so it
   * counts toward the job total and is REMOVED before any per-item rate is
   * worked out. Leaving it in would load every item on a small job with the
   * whole overhead: a one-shrub job is nearly all mobilization, and attributing
   * that to the shrub would teach a rate several times too high.
   */
  mobilizationHours: number;
};

export type VarianceReason =
  | null
  | "no_usable_time"
  | "nothing_estimated";

export type JobVariance = {
  jobId: string;
  jobName: string;
  estimatedManHours: number;
  actualManHours: number;
  /** actual / estimated. Above 1 means the job took longer than quoted. */
  ratio: number;
  /** Signed. +18 means the estimate ran 18% under what it took. */
  deltaPct: number;
  usable: boolean;
  reason: VarianceReason;
  time: ActualTime;
};

function round2(n: number) { return Math.round(n * 100) / 100; }

export function jobVariance(job: JobRecord): JobVariance {
  const time = actualManHours(job.entries);
  const mob = job.mobilizationHours > 0 ? job.mobilizationHours : 0;
  // Mobilization is part of what was estimated, because it is part of what was
  // clocked. Comparing item hours against total clocked time would report an
  // overrun on every job that ever left the yard.
  const estimated = round2(
    job.lines.reduce((a, l) => a + (l.manHours > 0 ? l.manHours : 0), 0) + mob
  );

  const base = {
    jobId: job.jobId,
    jobName: job.jobName,
    estimatedManHours: estimated,
    actualManHours: time.manHours,
    time,
  };

  if (time.manHours <= 0) {
    return { ...base, ratio: 0, deltaPct: 0, usable: false, reason: "no_usable_time" };
  }
  // A job with no rates entered has nothing to compare against. That is not a
  // 100% overrun, it is an unanswerable question.
  if (estimated <= 0) {
    return { ...base, ratio: 0, deltaPct: 0, usable: false, reason: "nothing_estimated" };
  }

  const ratio = time.manHours / estimated;
  return {
    ...base,
    ratio: round2(ratio),
    deltaPct: Math.round((ratio - 1) * 100),
    usable: true,
    reason: null,
  };
}

/* ── Calibration across jobs ──────────────────────────────────────────────── */

/**
 * Three, because that is what the industry guidance actually says: time your
 * next THREE installs. Below it no suggestion is offered — one job is an
 * anecdote and two is a coin toss.
 */
export const MIN_SAMPLE = 3;

/**
 * How far apart the observations may be before the sample is treated as
 * disagreeing with itself. Expressed as high / low, so 3 means the slowest job
 * took three times as long per unit as the fastest. Beyond that a median is
 * arithmetic rather than information — the jobs were not the same job.
 */
export const SPREAD_LIMIT = 3;

export type Calibration = {
  sampleSize: number;
  /** Median of actual/estimated. Median, not mean — see the comment below. */
  medianRatio: number;
  lowRatio: number;
  highRatio: number;
  enough: boolean;
  direction: "under" | "over" | "on_target";
  message: string;
};

/**
 * The whole-estimate calibration factor.
 *
 * MEDIAN, NOT MEAN, and for the same reason src/lib/manHours.ts uses one: a
 * single job that ran three days over because of rain would drag a mean — and
 * every quote built on it — upward for months. A median barely moves.
 */
export function calibration(variances: JobVariance[]): Calibration {
  const ratios = variances.filter((v) => v.usable).map((v) => v.ratio);
  const sampleSize = ratios.length;

  if (sampleSize === 0) {
    return {
      sampleSize: 0, medianRatio: 0, lowRatio: 0, highRatio: 0,
      enough: false, direction: "on_target",
      message: "No completed job yet has both an estimate and usable crew time.",
    };
  }

  const med = round2(median(ratios));
  const low = round2(Math.min(...ratios));
  const high = round2(Math.max(...ratios));
  const pct = Math.round((med - 1) * 100);
  // A tenth either way is noise on a hand-built estimate, not a trend.
  const direction = pct > 10 ? "under" : pct < -10 ? "over" : "on_target";
  const enough = sampleSize >= MIN_SAMPLE;

  const head =
    direction === "under"
      ? `Estimates ran ${pct}% under actual across ${sampleSize} job${sampleSize === 1 ? "" : "s"}.`
      : direction === "over"
        ? `Estimates ran ${Math.abs(pct)}% over actual across ${sampleSize} job${sampleSize === 1 ? "" : "s"}.`
        : `Estimates tracked actual within 10% across ${sampleSize} job${sampleSize === 1 ? "" : "s"}.`;

  const tail = enough
    ? `Range ${low}x to ${high}x.`
    : `Too few to act on — ${MIN_SAMPLE} jobs is the minimum worth reading.`;

  return { sampleSize, medianRatio: med, lowRatio: low, highRatio: high, enough, direction, message: `${head} ${tail}` };
}

/* ── Per-item rates ───────────────────────────────────────────────────────── */

/**
 * How an observation was attributed.
 *
 * `direct` — the estimate had exactly ONE billable line, so every man-hour on
 * that job belongs to it. No assumption at all.
 *
 * `proportional` — the job had several tasks and the hours were split by their
 * estimated share. That ASSUMES the overrun spread evenly across tasks, which
 * is a real assumption and can be wrong: the mulch may have gone fine and the
 * edging may have been terrible. Labelled so the screen can say so, and ranked
 * below direct wherever both exist.
 */
export type ObservationKind = "direct" | "proportional";

export type RateObservation = {
  jobId: string;
  key: string;
  label: string;
  unit: string;
  kind: ObservationKind;
  quantity: number;
  manHours: number;
  /** The figure the catalogue stores: man-MINUTES per unit. */
  manMinutesPerUnit: number;
};

/**
 * Observations from one job.
 *
 * NOTE THE LIMITATION, because it decides what this feature can teach: an item
 * with NO rate yet gets no proportional share (its estimated share is zero), so
 * a blank rate can only ever be learned from a job where it was the only task.
 * That is not a bug to route around — splitting a job's hours onto an item that
 * was estimated at nothing would be inventing the number, not observing it.
 */
export function observationsFor(job: JobRecord): RateObservation[] {
  const time = actualManHours(job.entries);
  if (time.manHours <= 0) return [];

  // Take the overhead off the top. What is left is the hours that were spent
  // ON the items, and it is the only pool a per-item rate may be drawn from.
  const mob = job.mobilizationHours > 0 ? job.mobilizationHours : 0;
  const attributable = time.manHours - mob;
  // Mobilization swallowed the whole job. Nothing is left to attribute, and
  // inventing a share would be worse than reporting none.
  if (attributable <= 0) return [];

  const billable = job.lines.filter((l) => l.quantity > 0);
  if (billable.length === 0) return [];

  const make = (
    l: EstimateTaskLine,
    kind: ObservationKind,
    hours: number
  ): RateObservation => ({
    jobId: job.jobId,
    key: l.key,
    label: l.label,
    unit: l.unit,
    kind,
    quantity: l.quantity,
    manHours: round2(hours),
    manMinutesPerUnit: Math.round(((hours * 60) / l.quantity) * 100) / 100,
  });

  // One task on the job means all of its hours are that task's. This is the
  // only attribution that needs no assumption, and it is the only one that can
  // teach a rate that is currently blank.
  if (billable.length === 1) {
    return [make(billable[0], "direct", attributable)];
  }

  const estimatedTotal = billable.reduce((a, l) => a + (l.manHours > 0 ? l.manHours : 0), 0);
  if (estimatedTotal <= 0) return [];

  return billable
    .filter((l) => l.manHours > 0)
    .map((l) => make(l, "proportional", attributable * (l.manHours / estimatedTotal)));
}

export function collectObservations(jobs: JobRecord[]): Map<string, RateObservation[]> {
  const byKey = new Map<string, RateObservation[]>();
  for (const job of jobs) {
    for (const o of observationsFor(job)) {
      const bucket = byKey.get(o.key);
      if (bucket) bucket.push(o);
      else byKey.set(o.key, [o]);
    }
  }
  return byKey;
}

export type RateSuggestion = {
  key: string;
  label: string;
  unit: string;
  sampleSize: number;
  directCount: number;
  /** True when the figures come from single-task jobs only. */
  directOnly: boolean;
  medianRate: number;
  lowRate: number;
  highRate: number;
  /** high / low. Above SPREAD_LIMIT the jobs were not comparable. */
  spread: number;
  currentRate: number;
  /** null unless the sample is big enough AND agrees with itself. */
  suggested: number | null;
  enough: boolean;
  agrees: boolean;
  message: string;
};

function round1(n: number) { return Math.round(n * 10) / 10; }

/**
 * Turn observations into a proposal — or into a reason there is no proposal.
 *
 * Direct observations are preferred outright: when there are enough of them the
 * proportional ones are dropped rather than blended in, because mixing a
 * measurement with an assumption produces something that is neither.
 */
export function rateSuggestion(
  key: string,
  label: string,
  unit: string,
  observations: RateObservation[],
  currentRate: number
): RateSuggestion {
  const direct = observations.filter((o) => o.kind === "direct");
  const directCount = direct.length;
  const use = directCount >= MIN_SAMPLE ? direct : observations;
  const rates = use.map((o) => o.manMinutesPerUnit).filter((r) => r > 0);
  const sampleSize = rates.length;

  const base = {
    key, label, unit, sampleSize, directCount,
    directOnly: directCount >= MIN_SAMPLE,
    currentRate,
  };

  if (sampleSize === 0) {
    return {
      ...base, medianRate: 0, lowRate: 0, highRate: 0, spread: 0,
      suggested: null, enough: false, agrees: false,
      message: "No usable observation yet.",
    };
  }

  const med = round1(median(rates));
  const low = round1(Math.min(...rates));
  const high = round1(Math.max(...rates));
  // A zero low would make the ratio infinite; the rates are already filtered
  // above 0, so this is belt-and-braces rather than a real branch.
  const spread = low > 0 ? Math.round((high / low) * 100) / 100 : 0;
  const enough = sampleSize >= MIN_SAMPLE;
  const agrees = spread > 0 && spread <= SPREAD_LIMIT;

  let message: string;
  if (!enough) {
    message = `${sampleSize} of ${MIN_SAMPLE} jobs needed before this is worth reading.`;
  } else if (!agrees) {
    message = `${sampleSize} jobs ranged ${low} to ${high} man-min per ${unit} — a ${spread}x spread, so these were not the same job. Look at them individually rather than taking a median.`;
  } else {
    const kindNote = base.directOnly
      ? "from single-task jobs"
      : "partly split across multi-task jobs, so treat it as indicative";
    message = `${sampleSize} jobs, ${kindNote}. Median ${med} man-min per ${unit}, range ${low} to ${high}.`;
  }

  return {
    ...base,
    medianRate: med, lowRate: low, highRate: high, spread,
    suggested: enough && agrees ? med : null,
    enough, agrees, message,
  };
}

/**
 * Sort so the screen leads with what is worth acting on: real proposals first,
 * then by how far they move the current figure.
 */
export function rankSuggestions(list: RateSuggestion[]): RateSuggestion[] {
  const shift = (s: RateSuggestion) =>
    s.suggested === null || s.currentRate <= 0
      ? 0
      : Math.abs(s.suggested - s.currentRate) / s.currentRate;
  return [...list].sort((a, b) => {
    if ((a.suggested !== null) !== (b.suggested !== null)) return a.suggested !== null ? -1 : 1;
    // A blank rate with a proposal is the most valuable row on the screen:
    // it is a number the org does not have yet.
    if ((a.currentRate <= 0) !== (b.currentRate <= 0)) return a.currentRate <= 0 ? -1 : 1;
    return shift(b) - shift(a);
  });
}

/**
 * Everything the screen needs, in one call: observations grouped by catalogue
 * row, turned into ranked proposals against the rates in force today.
 *
 * `currentRates` is keyed the same way the lines are, and a key that is absent
 * means the rate is blank — which is not the same as zero work, and is exactly
 * the row worth showing first.
 */
export function buildSuggestions(
  jobs: JobRecord[],
  currentRates: Map<string, number>
): RateSuggestion[] {
  const out: RateSuggestion[] = [];
  for (const [key, observations] of collectObservations(jobs)) {
    const first = observations[0];
    out.push(
      rateSuggestion(key, first.label, first.unit, observations, currentRates.get(key) ?? 0)
    );
  }
  return rankSuggestions(out);
}
