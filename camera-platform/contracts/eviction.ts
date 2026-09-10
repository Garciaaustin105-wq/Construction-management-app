/**
 * The ring buffer: what to delete when the disk fills.
 *
 * WHY this is a contract and not three lines inside the recorder: it is the
 * only code in the system whose job is to destroy footage. Every mistake here
 * is silent and permanent. The two failures it exists to prevent are evicting
 * footage under evidence hold, and evicting an incident clip whose cloud copy
 * has not been confirmed — in both cases the deletion removes the only copy of
 * the thing somebody is about to ask for.
 */

import { parseUtc } from "./time.js";
import { isEvictable, type StoredSegment } from "./store.js";

export interface EvictionCandidate {
  segment: StoredSegment;
  bytes: number;
}

export interface BlockedSegment {
  segment: StoredSegment;
  reason: "hold" | "pending_upload" | "open" | "unknown_size";
}

export type EvictionPlan =
  | {
      kind: "ok";
      evict: EvictionCandidate[];
      bytesFreed: number;
      blocked: BlockedSegment[];
    }
  | {
      kind: "insufficient";
      /** Still worth executing — it frees what it can. */
      evict: EvictionCandidate[];
      bytesFreed: number;
      shortfallBytes: number;
      blocked: BlockedSegment[];
      message: string;
    };

function blockReason(segment: StoredSegment): BlockedSegment["reason"] | null {
  if (segment.hold) return "hold";
  if (segment.pendingUpload) return "pending_upload";
  if (segment.state === "open") return "open";
  if (segment.bytes === null) return "unknown_size";
  return null;
}

/**
 * Choose the oldest evictable segments until `bytesToFree` is satisfied.
 *
 * Returns `insufficient` rather than reaching into protected segments. That is
 * a deliberate refusal: a disk full of held evidence is an operational problem
 * for a human, not a licence to delete the evidence.
 */
export function planEviction(
  segments: readonly StoredSegment[],
  bytesToFree: number,
): EvictionPlan {
  if (!Number.isFinite(bytesToFree) || bytesToFree <= 0) {
    return { kind: "ok", evict: [], bytesFreed: 0, blocked: [] };
  }

  const blocked: BlockedSegment[] = [];
  const candidates: EvictionCandidate[] = [];

  for (const segment of segments) {
    const reason = blockReason(segment);
    if (reason !== null) {
      blocked.push({ segment, reason });
      continue;
    }
    // blockReason has already ruled out a null byte count.
    candidates.push({ segment, bytes: segment.bytes as number });
  }

  // Oldest first. A ring buffer that evicted newest-first would keep a month of
  // last year and none of this morning.
  candidates.sort((a, b) => parseUtc(a.segment.startUtc) - parseUtc(b.segment.startUtc));

  const evict: EvictionCandidate[] = [];
  let bytesFreed = 0;
  for (const candidate of candidates) {
    if (bytesFreed >= bytesToFree) break;
    evict.push(candidate);
    bytesFreed += candidate.bytes;
  }

  if (bytesFreed >= bytesToFree) {
    return { kind: "ok", evict, bytesFreed, blocked };
  }

  const heldBytes = blocked
    .filter((b) => b.reason === "hold" || b.reason === "pending_upload")
    .reduce((sum, b) => sum + (b.segment.bytes ?? 0), 0);

  return {
    kind: "insufficient",
    evict,
    bytesFreed,
    shortfallBytes: bytesToFree - bytesFreed,
    blocked,
    message:
      `cannot free ${bytesToFree} bytes: ${bytesFreed} available from evictable segments, ` +
      `${heldBytes} bytes are under hold or awaiting upload and will not be deleted`,
  };
}

/** Bytes to free to get back under budget, given what is currently used. */
export function bytesToFreeFor(usedBytes: number, budgetBytes: number, headroomFraction = 0.05): number {
  if (headroomFraction < 0 || headroomFraction >= 1) {
    throw new RangeError(`headroomFraction must be in [0,1), got ${headroomFraction}`);
  }
  const target = budgetBytes * (1 - headroomFraction);
  return Math.max(0, usedBytes - target);
}
