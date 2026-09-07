/**
 * How far through pricing a catalogue an org actually is — and, more usefully,
 * how far they NEED to be.
 *
 * THE PROBLEM THIS EXISTS FOR. A new org now starts with a shipped catalogue:
 * 223 species across 690 sizes, 38 labor lines, 73 components, 145 nozzles, all
 * with no prices, because prices belong to the org and seeding one would be
 * inventing their business. That is correct and it looks like a cliff. "0 of
 * 690 priced" reads as 690 units of homework before the software is usable, and
 * a person who believes that closes the tab.
 *
 * IT IS NOT TRUE, and this file exists to say so honestly rather than by
 * cheerleading. Nobody sells 223 species. A contractor prices the dozen things
 * they actually install, and the rest of the catalogue sits there as a list to
 * pick from later. So readiness is reported as:
 *
 *   - CAN YOU QUOTE AT ALL — one priced row in a group is enough to start.
 *   - WHAT IS BLOCKING YOU — rows you have already put on an estimate that have
 *     no price. These are real: the quote is wrong until they are filled in.
 *   - What is merely unpriced — everything else, and explicitly NOT a task.
 *
 * The distinction between the second and third is the whole point. One is four
 * things to fix. The other is six hundred and ninety things to ignore.
 *
 * Pure. No database.
 */

export type CatalogueGroup =
  | "plants"
  | "sod"
  | "labor"
  | "components"
  | "nozzles";

export type GroupCounts = {
  group: CatalogueGroup;
  /** Rows in the catalogue. */
  total: number;
  /** Rows with a price recorded. */
  priced: number;
  /**
   * Rows with no price that are ALREADY USED on an estimate. Blocking, because
   * a quote containing them is understated until they are filled in.
   */
  blocking: number;
};

export type GroupReadiness = GroupCounts & {
  /** At least one priced row: you can quote something in this group. */
  started: boolean;
  /** Nothing used is unpriced. Not the same as everything being priced. */
  clear: boolean;
  message: string;
};

export type CatalogueReadiness = {
  groups: GroupReadiness[];
  /** Rows used on an estimate with no price, across every group. */
  totalBlocking: number;
  /** Groups with at least one priced row. */
  startedGroups: number;
  headline: string;
  /** Null when nothing is blocking. Never a nag about merely unpriced rows. */
  callToAction: string | null;
};

const GROUP_LABEL: Record<CatalogueGroup, string> = {
  plants: "Plants",
  sod: "Sod",
  labor: "Labor items",
  components: "Irrigation parts",
  nozzles: "Sprinkler nozzles",
};

const GROUP_NOUN: Record<CatalogueGroup, string> = {
  plants: "plant size",
  sod: "sod product",
  labor: "labor item",
  components: "part",
  nozzles: "nozzle",
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function groupReadiness(counts: GroupCounts): GroupReadiness {
  const started = counts.priced > 0;
  const clear = counts.blocking === 0;
  const noun = GROUP_NOUN[counts.group];
  const label = GROUP_LABEL[counts.group];

  let message: string;
  if (counts.total === 0) {
    // Genuinely empty, which is different from unpriced and much rarer now the
    // catalogue ships. Say what it is rather than reporting 0 of 0 priced.
    message = `No ${label.toLowerCase()} in your catalogue yet.`;
  } else if (!clear) {
    // The only state that is actually a task.
    message = `${plural(counts.blocking, noun)} on your estimates have no price. Those quotes are understated until you fill them in.`;
  } else if (!started) {
    message = `Nothing priced yet. Price the ${noun}s you actually install — you do not need the other ${counts.total - counts.priced}.`;
  } else {
    message = `${plural(counts.priced, noun)} priced, and nothing on an estimate is missing one. The remaining ${counts.total - counts.priced} are there when you need them.`;
  }

  return { ...counts, started, clear, message };
}

export function catalogueReadiness(groups: GroupCounts[]): CatalogueReadiness {
  const rows = groups.map(groupReadiness);
  const totalBlocking = rows.reduce((n, g) => n + g.blocking, 0);
  const startedGroups = rows.filter((g) => g.started).length;
  const withRows = rows.filter((g) => g.total > 0);

  let headline: string;
  if (withRows.length === 0) {
    headline = "Your catalogue is empty.";
  } else if (totalBlocking > 0) {
    headline = `${totalBlocking} thing${totalBlocking === 1 ? "" : "s"} you have already quoted have no price.`;
  } else if (startedGroups === 0) {
    // The cliff, met head on. The number that matters is not how much is
    // unpriced; it is how little has to be.
    headline =
      "Nothing is priced yet — that is normal on day one. Price one thing and you can quote with it.";
  } else {
    headline = "You can quote. Price the rest as you sell it.";
  }

  // A call to action ONLY when something is actually wrong. Nagging about
  // unpriced rows that nobody has used would recreate the cliff in a banner.
  const blocked = rows.filter((g) => g.blocking > 0);
  const callToAction =
    blocked.length === 0
      ? null
      : `Fix ${blocked
          .map((g) => `${g.blocking} in ${GROUP_LABEL[g.group].toLowerCase()}`)
          .join(", ")}.`;

  return { groups: rows, totalBlocking, startedGroups, headline, callToAction };
}

/**
 * The honest framing, shown where the shipped catalogue is first met.
 *
 * Two jobs: say the list is a starting point rather than a recommendation, and
 * kill the assumption that all of it has to be priced before anything works.
 */
export const CATALOGUE_STARTING_POINT_NOTE =
  "This catalogue ships as a starting point, not a recommendation. The names, categories and units are yours to keep or delete; the prices are blank because they are yours to set, and no software should guess what your suppliers charge you. You do not need to price all of it — price what you actually install, and the rest is a list to pick from later.";

/** Said where a region-specific list could mislead. */
export const CATALOGUE_REGION_NOTE =
  "The plant list is weighted to the Southeast. If you work somewhere else, expect to delete a good deal of it and add your own — that is faster than starting from nothing, which is the only reason it ships.";
