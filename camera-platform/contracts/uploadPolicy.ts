/**
 * Which detections become timeline events.
 *
 * **Clips are not copied to the cloud.** An event is a timestamp pointing into
 * the continuous recording already on the appliance; clicking a marker seeks
 * there and streams it on demand. Nothing is duplicated, so the only bytes that
 * ever leave a site are the ones somebody asked to watch.
 *
 * This module was first written to cap cloud clip storage. That is no longer its
 * job, and it turns out to matter more for the reason it kept: **a timeline is
 * useless if every pixel is a marker.** A car wash generates vehicle detections
 * continuously all day; recorded as events, the bar becomes a solid stripe and
 * the one detection anybody wanted is invisible inside fifty thousand cars being
 * washed. Filtering is what keeps the timeline readable.
 *
 * Two rules shape everything below.
 *
 * **Expected activity is not an event.** A vehicle at a car wash at 2pm is the
 * business operating. The same vehicle at 2am is why the cameras are there.
 *
 * **Never drop silently.** Whatever is filtered out is still indexed locally and
 * still findable; and where a byte budget does apply — to the optional keyframe
 * below — exhausting it is recorded as a decision with a reason rather than
 * becoming an absence nobody can interpret.
 *
 * The one thing worth considering uploading is a **single keyframe** with a
 * high-priority event: 40 KB against a 9.4 MB clip. If the recorder is stolen —
 * the industry's own stated primary risk — that picture is the only surviving
 * evidence of whoever took it, and it costs about half a cent a month across a
 * 150-site estate. Off by default; the decision is the customer's, since it is
 * their footage leaving their premises.
 */

import { parseUtc } from "./time.js";
import type { DetectionKind } from "./timeline.js";

export type SiteKind = "storage" | "carwash" | "generic";

export interface OpenHours {
  /** Minutes from local midnight. 480 = 08:00. */
  openMinute: number;
  closeMinute: number;
  /** IANA-style offset in minutes applied to the UTC instant. */
  utcOffsetMinutes: number;
}

export interface UploadCandidate {
  cameraId: string;
  atUtc: string;
  kind: DetectionKind;
  confidence: number;
  estimatedBytes: number;
  /** Set by the appliance for tamper, power loss, or a triggered alarm input. */
  alarm?: boolean;
}

export interface BudgetState {
  spentTodayBytes: number;
  dailyBudgetBytes: number;
  spentMonthBytes: number;
  monthlyBudgetBytes: number;
  /** Last upload per `${cameraId}|${kind}`, as epoch ms. */
  lastUploadMs: Record<string, number>;
}

export interface PolicyConfig {
  siteKind: SiteKind;
  hours: OpenHours;
  /** Minimum gap between uploads for the same camera and kind. */
  cooldownSeconds: number;
  minConfidence: number;
}

/** `upload` here means "becomes a timeline event", and — only if the site
 *  opts in — carries a single keyframe. Never a clip. */
export type UploadDecision =
  | { kind: "upload"; priority: number; reason: string; bypassedBudget?: true }
  | { kind: "index_only"; reason: string }
  | { kind: "budget_exhausted"; reason: string; spentBytes: number; budgetBytes: number };

export const DEFAULT_POLICY: Record<SiteKind, Omit<PolicyConfig, "hours" | "siteKind">> = {
  // Corridors are quiet. Almost any person is worth a clip.
  storage: { cooldownSeconds: 60, minConfidence: 0.6 },
  // Vehicles all day is the business running, not an incident.
  carwash: { cooldownSeconds: 300, minConfidence: 0.7 },
  generic: { cooldownSeconds: 120, minConfidence: 0.65 },
};

function isOpen(atUtc: string, hours: OpenHours): boolean {
  const localMs = parseUtc(atUtc) + hours.utcOffsetMinutes * 60_000;
  const minute = Math.floor(localMs / 60_000) % 1440;
  // A window crossing midnight (22:00–06:00) is two ranges, not one.
  return hours.openMinute <= hours.closeMinute
    ? minute >= hours.openMinute && minute < hours.closeMinute
    : minute >= hours.openMinute || minute < hours.closeMinute;
}

/** Higher is more worth the bytes. */
function priorityOf(candidate: UploadCandidate, open: boolean, siteKind: SiteKind): number {
  if (candidate.alarm === true) return 100;
  const afterHours = !open;
  switch (candidate.kind) {
    case "person": return afterHours ? 90 : 40;
    case "plate": return afterHours ? 80 : 50;   // plates matter at a car wash by day too
    case "vehicle":
      if (afterHours) return 70;
      return siteKind === "carwash" ? 5 : 30;    // daytime cars ARE the car wash
    case "motion": return afterHours ? 20 : 1;
  }
}

/**
 * Decide the fate of one detection.
 *
 * Order matters: alarms bypass everything, because losing the clip of somebody
 * attacking the recorder — while the day's budget went on cars being washed —
 * is precisely the outcome the budget exists to avoid.
 */
export function decideUpload(
  candidate: UploadCandidate,
  config: PolicyConfig,
  budget: BudgetState,
): UploadDecision {
  const open = isOpen(candidate.atUtc, config.hours);
  const priority = priorityOf(candidate, open, config.siteKind);

  if (candidate.alarm === true) {
    return { kind: "upload", priority, reason: "alarm or tamper — always uploaded", bypassedBudget: true };
  }

  if (candidate.confidence < config.minConfidence) {
    return { kind: "index_only", reason: `confidence ${candidate.confidence.toFixed(2)} below ${config.minConfidence}` };
  }

  if (config.siteKind === "carwash" && open && candidate.kind === "vehicle") {
    return { kind: "index_only", reason: "a vehicle at a car wash during opening hours is the business, not an event" };
  }
  if (candidate.kind === "motion" && open) {
    return { kind: "index_only", reason: "motion during opening hours is not worth a cloud copy" };
  }

  const cooldownKey = `${candidate.cameraId}|${candidate.kind}`;
  const last = budget.lastUploadMs[cooldownKey];
  if (last !== undefined) {
    const sinceSeconds = (parseUtc(candidate.atUtc) - last) / 1000;
    if (sinceSeconds < config.cooldownSeconds) {
      return {
        kind: "index_only",
        reason: `within ${config.cooldownSeconds}s cooldown for ${candidate.kind} on this camera`,
      };
    }
  }

  if (budget.spentTodayBytes + candidate.estimatedBytes > budget.dailyBudgetBytes) {
    return {
      kind: "budget_exhausted",
      reason: "daily cloud upload budget spent — coverage gap recorded",
      spentBytes: budget.spentTodayBytes,
      budgetBytes: budget.dailyBudgetBytes,
    };
  }
  if (budget.spentMonthBytes + candidate.estimatedBytes > budget.monthlyBudgetBytes) {
    return {
      kind: "budget_exhausted",
      reason: "monthly cloud upload budget spent — coverage gap recorded",
      spentBytes: budget.spentMonthBytes,
      budgetBytes: budget.monthlyBudgetBytes,
    };
  }

  return { kind: "upload", priority, reason: open ? "notable during opening hours" : "after hours" };
}

/** What a site would cost per month at a given event rate, for sizing a budget. */
export function projectedMonthlyBytes(uploadsPerDay: number, averageClipBytes: number): number {
  return uploadsPerDay * averageClipBytes * 30;
}
