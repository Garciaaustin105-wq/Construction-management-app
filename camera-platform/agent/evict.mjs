/**
 * Eviction against a full-size index.
 *
 * `planEviction` is pure and takes whatever it is given — which is right for a
 * contract, and wrong if the caller hands it the entire index. At 30 days of
 * retention that is 691,200 rows, 6.8 seconds and ~180 MB of objects to decide
 * on a hundred deletions.
 *
 * So the candidate set is bounded here: ask SQLite for the oldest deletable
 * segments, oldest first, and take more only if the first page was not enough.
 * The pure planner still makes every decision about what may be deleted.
 */
import { planEviction } from "../dist/eviction.js";

const FIRST_PAGE = 512;
const MAX_PAGE = 16_384;

export function planEvictionScalable(index, bytesToFree, { firstPage = FIRST_PAGE } = {}) {
  if (!Number.isFinite(bytesToFree) || bytesToFree <= 0) {
    return { kind: "ok", evict: [], bytesFreed: 0, blocked: [], pagesRead: 0 };
  }

  let limit = firstPage;
  let pagesRead = 0;

  for (;;) {
    const candidates = index.oldestEvictable(limit);
    pagesRead++;
    const plan = planEviction(candidates, bytesToFree);

    // Enough freed, or the index has no more candidates to offer.
    if (plan.kind === "ok" || candidates.length < limit || limit >= MAX_PAGE) {
      return { ...plan, pagesRead };
    }
    limit = Math.min(limit * 4, MAX_PAGE);
  }
}
