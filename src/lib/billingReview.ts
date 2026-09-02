export type ReviewInput = {
  visitId: string;
  jobName: string;
  customerName: string | null;
  dueDate: string;                  // "YYYY-MM-DD"
  onSiteFirstAt: string | null;     // ISO, from the geofence
  onSiteLastAt: string | null;      // ISO
  startedAt: string | null;         // ISO, crew tapped start
  completedAt: string | null;       // ISO, crew tapped done
  crewSize: number | null;          // >= 1, or null if unknown
  pricePerVisit: number | null;     // USD major units, flat, from the schedule
};

export type ReviewRow = {
  visitId: string;
  jobName: string;
  customerName: string | null;
  dueDate: string;
  minutes: number | null;           // whole minutes, rounded
  minutesSource: "measured" | "tapped" | null;
  manHours: number | null;          // rounded to 2 decimals
  price: number | null;             // pass-through of pricePerVisit
  impliedHourly: number | null;     // price / manHours, 2 decimals
  verdict: Verdict;
};

export type Verdict =
  | "ok"          // within tolerance of the median implied hourly
  | "under"       // impliedHourly is far BELOW median — we are losing money here
  | "over"        // impliedHourly is far ABOVE median — check for a bad measurement
  | "unpriced"    // no pricePerVisit
  | "unmeasured"; // no usable duration

export type ReviewSummary = {
  rows: ReviewRow[];
  medianHourly: number | null;      // median of impliedHourly over "ok"-eligible rows
  totalPrice: number;               // sum of non-null price
  totalManHours: number;            // sum of non-null manHours, 2 decimals
  counts: Record<Verdict, number>;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const parseIso = (s: string | null): Date | null => {
  if (s == null) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const computeMinutes = (input: ReviewInput): { minutes: number | null; minutesSource: "measured" | "tapped" | null } => {
  const first = parseIso(input.onSiteFirstAt);
  const last = parseIso(input.onSiteLastAt);
  if (first && last && last > first) {
    const diffMs = last.getTime() - first.getTime();
    const minutes = Math.round(diffMs / 60000);
    return { minutes, minutesSource: "measured" };
  }
  const start = parseIso(input.startedAt);
  const end = parseIso(input.completedAt);
  if (start && end && end > start) {
    const diffMs = end.getTime() - start.getTime();
    const minutes = Math.round(diffMs / 60000);
    return { minutes, minutesSource: "tapped" };
  }
  return { minutes: null, minutesSource: null };
};

const computeManHours = (minutes: number | null, crewSize: number | null): number | null => {
  if (minutes == null || crewSize == null || crewSize < 1) return null;
  const hours = (minutes / 60) * crewSize;
  return round2(hours);
};

const computeImpliedHourly = (price: number | null, manHours: number | null): number | null => {
  if (price == null || price === 0 || manHours == null || manHours === 0) return null;
  return round2(price / manHours);
};

const verdictPriority = (v: Verdict): number => {
  switch (v) {
    case "under": return 1;
    case "over": return 2;
    case "unmeasured": return 3;
    case "unpriced": return 4;
    case "ok": return 5;
  }
};

export function buildReview(
  inputs: ReviewInput[],
  opts?: { tolerance?: number }
): ReviewSummary {
  const tolerance = opts?.tolerance ?? 0.35;

  const rows: ReviewRow[] = inputs.map((input) => {
    const { minutes, minutesSource } = computeMinutes(input);
    const manHours = computeManHours(minutes, input.crewSize);
    const price = input.pricePerVisit;
    const impliedHourly = computeImpliedHourly(price, manHours);

    let verdict: Verdict;
    if (price == null || price === 0) {
      verdict = "unpriced";
    } else if (manHours == null) {
      verdict = "unmeasured";
    } else {
      verdict = "ok"; // placeholder, will adjust after median
    }

    return {
      visitId: input.visitId,
      jobName: input.jobName,
      customerName: input.customerName,
      dueDate: input.dueDate,
      minutes,
      minutesSource,
      manHours,
      price,
      impliedHourly,
      verdict,
    };
  });

  // Compute medianHourly from rows with non-null impliedHourly
  const impliedValues = rows
    .map((r) => r.impliedHourly)
    .filter((v): v is number => v != null);
  let medianHourly: number | null = null;
  if (impliedValues.length >= 3) {
    const sorted = [...impliedValues].sort((a, b) => a - b);
    const len = sorted.length;
    if (len % 2 === 1) {
      medianHourly = sorted[(len - 1) / 2];
    } else {
      const mid1 = sorted[len / 2 - 1];
      const mid2 = sorted[len / 2];
      medianHourly = round2((mid1 + mid2) / 2);
    }
  }

  // Adjust verdicts based on median and tolerance
  rows.forEach((r) => {
    if (r.verdict !== "ok") return; // already set to unpriced/unmeasured
    // A row with no computable rate is unmeasurable however much data exists,
    // so this MUST precede the median short-circuit below. The only way to
    // reach here with a null rate is manHours === 0 — a visit so short it
    // rounds to zero minutes. Ordered the other way it reads "ok", which is
    // the one verdict that says "we checked this and it is fine".
    if (r.impliedHourly == null) {
      r.verdict = "unmeasured";
      return;
    }
    if (medianHourly == null) {
      r.verdict = "ok";
      return;
    }
    const underBound = medianHourly * (1 - tolerance);
    const overBound = medianHourly * (1 + tolerance);
    if (r.impliedHourly != null) {
      if (r.impliedHourly < underBound) {
        r.verdict = "under";
      } else if (r.impliedHourly > overBound) {
        r.verdict = "over";
      } else {
        r.verdict = "ok";
      }
    } else {
      r.verdict = "unmeasured";
    }
  });

  // Sort rows
  const sortedRows = [...rows].sort((a, b) => {
    const pA = verdictPriority(a.verdict);
    const pB = verdictPriority(b.verdict);
    if (pA !== pB) return pA - pB;
    if (a.dueDate < b.dueDate) return 1;
    if (a.dueDate > b.dueDate) return -1;
    return 0;
  });

  // Compute totals and counts
  const counts: Record<Verdict, number> = {
    ok: 0,
    under: 0,
    over: 0,
    unpriced: 0,
    unmeasured: 0,
  };
  let totalPrice = 0;
  let totalManHours = 0;
  sortedRows.forEach((r) => {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    if (r.price != null) totalPrice += r.price;
    if (r.manHours != null) totalManHours += r.manHours;
  });
  totalManHours = round2(totalManHours);

  return {
    rows: sortedRows,
    medianHourly,
    totalPrice,
    totalManHours,
    counts,
  };
}
