/**
 * How long recordings are kept: recording.json in the state dir, set on the
 * Recording page (storage.manage). Pure: the caller reads the file, passes the
 * time, and does the deleting.
 *
 * Two limits, whichever comes first:
 * - the drive filling (always on: the ring buffer in recorder-service);
 * - `maxDays`, when set: footage older than that is deleted even with space
 *   left. Null means no age limit, kept until the drive needs the space.
 *
 * THE FEARED FAILURES:
 * - a missing, broken or hand-edited file deleting footage. Anything that is
 *   not a valid settings file reads as NO age limit, and says why;
 * - lowering the limit deleting weeks of footage with nobody told. Saving a
 *   limit that would delete footage is refused until the person has been shown
 *   how much and confirms (confirmSave);
 * - a segment only partly past the limit deleted: only segments that ENDED
 *   before the cutoff are old enough.
 */

export const RECORDING_FILE = "recording.json";
export const MIN_DAYS = 1;
export const MAX_DAYS = 365;
const MS_PER_DAY = 86_400_000;

export interface RecordingSettings {
  /** Whole days, MIN_DAYS..MAX_DAYS, or null for no age limit. */
  maxDays: number | null;
}

export const DEFAULT_RECORDING_SETTINGS: Readonly<RecordingSettings> = Object.freeze({ maxDays: null });

export type RecordingCheck =
  | { ok: true; settings: RecordingSettings }
  | { ok: false; reason: "not_an_object" | "bad_max_days" | "unknown_key"; field?: string };

/** A request body or a parsed file. Unknown keys are refused, not ignored. */
export function checkRecordingSettings(raw: unknown): RecordingCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_an_object" };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "maxDays" && key !== "version") return { ok: false, reason: "unknown_key", field: key };
  }
  const days = obj.maxDays;
  if (days === null) return { ok: true, settings: { maxDays: null } };
  if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return { ok: false, reason: "bad_max_days", field: "maxDays" };
  }
  return { ok: true, settings: { maxDays: days } };
}

export type RecordingFileRead = {
  settings: RecordingSettings;
  /** Null when the file was absent (the default) or valid. */
  problem: null | "unreadable" | "not_json" | "invalid";
};

/**
 * `text` is the file's contents, null when it does not exist, or undefined
 * when it exists but could not be read. Every failure is no age limit.
 */
export function readRecordingFile(text: string | null | undefined): RecordingFileRead {
  const none = { maxDays: null };
  if (text === null) return { settings: none, problem: null };
  if (text === undefined) return { settings: none, problem: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { settings: none, problem: "not_json" };
  }
  const r = checkRecordingSettings(parsed);
  return r.ok ? { settings: r.settings, problem: null } : { settings: none, problem: "invalid" };
}

export function recordingFileText(settings: RecordingSettings): string {
  return JSON.stringify({ version: 1, maxDays: settings.maxDays }, null, 2) + "\n";
}

/**
 * Segments that ended strictly before this instant are past the limit.
 * Null when there is no limit or the clock is not a real time.
 */
export function ageCutoffMs(settings: RecordingSettings, nowMs: number): number | null {
  if (settings.maxDays === null || !Number.isFinite(nowMs)) return null;
  return nowMs - settings.maxDays * MS_PER_DAY;
}

/** What saving a new limit would delete, as the index counts it. */
export interface WouldDelete {
  segments: number;
  bytes: number;
  /** Start of the oldest segment that would go, or null when none. */
  oldestUtc: string | null;
}

export type SaveDecision =
  | { save: true }
  | { save: false; reason: "would_delete"; wouldDelete: WouldDelete };

/**
 * Whether to write the new settings now. A limit that deletes nothing saves;
 * one that deletes footage saves only with `confirm === true` (exactly true:
 * "yes", 1 or a missing field is not a confirmation).
 */
export function confirmSave(wouldDelete: WouldDelete, confirm: unknown): SaveDecision {
  if (wouldDelete.segments === 0 || confirm === true) return { save: true };
  return { save: false, reason: "would_delete", wouldDelete };
}
