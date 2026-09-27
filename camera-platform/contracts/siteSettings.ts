/**
 * Site settings: the installer-only knobs that describe the whole box rather
 * than one camera or one drive — display name, time zone, site type and the
 * per-site feature switches (SITE-SETTINGS-SPEC.md, section 1).
 *
 * Pure: no I/O, no clock of its own. `<stateDir>/site.json`, its read/write
 * and its audit line belong to agent/ (not written by this file, following
 * the same split contracts/cameraAiSettings.ts already keeps from
 * agent/camera-ai-settings.mjs).
 *
 * THE FEARED FAILURES, by name:
 * - a missing site.json read as "every feature off" instead of "every
 *   feature at its own registry default" (build rule 5 — a blank is not a
 *   zero; a site that never touched this file must keep the exact behaviour
 *   it had before this feature existed);
 * - a preset silently reapplying on every later save and stamping over a
 *   switch the installer deliberately changed by hand afterwards — "a preset
 *   never changes switches silently later: it applies once, when chosen";
 * - a preset naming a feature that does not exist yet (`managerRules`,
 *   `appearanceOfDay`) and that name leaking into the stored file as a
 *   feature nobody can ever turn off because no route reads it — applyPreset
 *   only ever writes keys FEATURE_REGISTRY actually lists;
 * - an unknown feature key, or a non-IANA time zone, saved anyway instead of
 *   refused with every problem at once (never a fix-and-resave loop);
 * - the effective time zone silently drifting: "existing schedules keep the
 *   zone they were saved in; never shift them silently" — this file only
 *   ever answers "what zone is EFFECTIVE now", it never rewrites a zone
 *   already stored somewhere else (that belongs to
 *   contracts/cameraAiSettings.ts's own file, a separate owner).
 *
 * `openHours` (MANAGER-RULES-SPEC.md section 3) is additive to the shape
 * above: a `Schedule` (contracts/alertRules.ts) or `null` — null meaning "not
 * set", never "always closed" (build rule 5, a blank is not a zero). A
 * manager rule using `when: "open_hours"` or `"closed_hours"` while this is
 * null is refused at the RULE's own save time (contracts/managerRules.ts's
 * checkManagerRule), never guessed here or there.
 */

// ---------------------------------------------------------------- constants

import { checkSchedule } from "./alertRules.js";
import type { Schedule } from "./alertRules.js";

export const SITE_SETTINGS_VERSION = 1;

/** Matches cameraEdit.ts's own `name` rule ("a string of at most N
 *  characters without control characters, or null/absent; trimmed; blank
 *  becomes null") — the same shape of field, a different owner. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_DISPLAY_NAME_LENGTH = 80;

export type SiteType = "retail" | "storage" | "carwash" | "home" | "other";

export const SITE_TYPES: readonly SiteType[] = Object.freeze(["retail", "storage", "carwash", "home", "other"]);

function isSiteType(v: unknown): v is SiteType {
  return typeof v === "string" && (SITE_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- the feature registry

/**
 * Every switchable feature that exists today, and the value a site that has
 * never touched site.json (or never touched this particular key) gets.
 *
 * Deliberately NOT here: recording, live, review, health, the network page,
 * camera AI settings — "Always on, not switchable" (SITE-SETTINGS-SPEC.md).
 * A feature not in this list is not a feature this file knows how to switch,
 * whatever a preset or a stored file happens to say about it.
 *
 * `activity`'s own default is `true`: the Activity page had no per-site
 * switch before this spec, so a site that never opens the new Site section at
 * all must see exactly the behaviour it already had (build rule 5).
 */
export interface FeatureDefinition {
  key: string;
  registryDefault: boolean;
}

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = Object.freeze([
  Object.freeze({ key: "activity", registryDefault: true }),
  // Manager rules (MANAGER-RULES-SPEC.md section 4): off by default — "some
  // sites are storage facilities or homes" and this switch decides whether
  // detect-service samples any occupancy at all, so a site that never opens
  // the Site section must keep sampling NOTHING, not "on until told
  // otherwise" (build rule 5's own "a blank is not a zero", the other way).
  Object.freeze({ key: "managerRules", registryDefault: false }),
  // Appearance of day (APPEARANCE-OF-DAY-SPEC.md, build 3): off by default in
  // EVERY preset, including retail — "the owner's own words: we don't need
  // facial rec" is a per-store choice, made by whoever installs the box, not
  // a default anyone should have to opt out of. Off means nothing is computed
  // and nothing is sent (the worker's own --appearance flag stays unset).
  Object.freeze({ key: "appearanceOfDay", registryDefault: false }),
]);

const FEATURE_KEYS: ReadonlySet<string> = new Set(FEATURE_REGISTRY.map((f) => f.key));

/** Every switchable feature at its own registry default — what a site that
 *  has never saved site.json, or never saved THIS key, is running today. */
function defaultFeatures(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of FEATURE_REGISTRY) out[f.key] = f.registryDefault;
  return out;
}

/** Whether `key` is on, for a caller that only has a (possibly partial, or
 *  entirely absent) features map — an unlisted feature, or one this
 *  particular file happens to be missing, reads at its registry default,
 *  never `false` by omission. An unknown `key` (not in the registry at all)
 *  is always off: nothing switches on a feature this file has never heard of. */
export function isFeatureEnabled(features: Readonly<Record<string, boolean>> | undefined, key: string): boolean {
  const def = FEATURE_REGISTRY.find((f) => f.key === key);
  if (def === undefined) return false;
  const v = features === undefined ? undefined : features[key];
  return typeof v === "boolean" ? v : def.registryDefault;
}

// ---------------------------------------------------------------- site-type presets

/**
 * What choosing a site type pre-selects. Presets are written to name every
 * feature the spec already knows will exist ("Presets name future features
 * too, so they turn on the moment those features exist") — but a preset
 * naming a key ahead of FEATURE_REGISTRY listing it is inert until that day:
 * applyPreset below only ever copies a key that FEATURE_REGISTRY lists, so
 * adding a preset entry for a feature that does not exist yet is always safe
 * and never leaks an unreadable key into a stored file.
 *
 * Values here are exactly SITE-SETTINGS-SPEC.md's own table:
 *   retail: activity on · storage: activity on · carwash: activity on ·
 *   home: activity off · other: activity on.
 */
export const SITE_TYPE_PRESETS: Readonly<Record<SiteType, Readonly<Record<string, boolean>>>> = Object.freeze({
  // appearanceOfDay: false everywhere, on purpose — "a per-site switch,
  // because some stores use uniforms" (MANAGER-RULES-SPEC.md build 3): the
  // installer turns it on per store, no preset ever turns it on for them.
  retail: Object.freeze({ activity: true, managerRules: true, appearanceOfDay: false }),
  storage: Object.freeze({ activity: true, managerRules: true, appearanceOfDay: false }),
  carwash: Object.freeze({ activity: true, managerRules: true, appearanceOfDay: false }),
  home: Object.freeze({ activity: false, managerRules: false, appearanceOfDay: false }),
  other: Object.freeze({ activity: true, managerRules: false, appearanceOfDay: false }),
});

// ---------------------------------------------------------------- appearance match threshold

/** "50-99, default 80" (MANAGER-RULES-SPEC.md's appearance-of-day matching). */
export const MIN_APPEARANCE_MATCH_PERCENT = 50;
export const MAX_APPEARANCE_MATCH_PERCENT = 99;
export const DEFAULT_APPEARANCE_MATCH_PERCENT = 80;

// ---------------------------------------------------------------- shapes

/** The settings themselves, always fully populated: `features` carries every
 *  registry key, never a partial map a reader has to fill in by hand. */
export interface SiteSettings {
  displayName: string | null;
  timeZone: string | null;
  siteType: SiteType | null;
  features: Record<string, boolean>;
  /** MANAGER-RULES-SPEC.md section 3. null = not set (never "always closed"). */
  openHours: Schedule | null;
  /**
   * "The threshold is a per-site setting, default 80%" (MANAGER-RULES-
   * SPEC.md's appearance-of-day matching). Always populated — a site that
   * never touched this field reads the registry-style default, the same
   * "a blank is not a zero" discipline every other field here already keeps.
   */
  appearanceMatchPercent: number;
}

export interface StoredSiteSettings extends SiteSettings {
  updatedUtc: string;
  updatedBy: string;
}

/** As stored in site.json. Flat, matching the spec's own JSON verbatim —
 *  there is one site, so there is no per-id map the way camera-ai.json needs
 *  one entry per camera. */
export interface SiteSettingsFile extends StoredSiteSettings {
  version: 1;
}

/** "A missing site.json means displayName null, timeZone null (the system
 *  zone), siteType null, and every feature at its registry default." The
 *  caller uses this directly for an ENOENT — it never reaches
 *  checkSiteSettingsFile, the same way camera-ai-settings.mjs's own
 *  `emptyFile()` never goes through checkCameraAiSettingsFile either. */
export function defaultSiteSettings(): SiteSettings {
  return {
    displayName: null,
    timeZone: null,
    siteType: null,
    features: defaultFeatures(),
    openHours: null,
    appearanceMatchPercent: DEFAULT_APPEARANCE_MATCH_PERCENT,
  };
}

// ---------------------------------------------------------------- validation

export interface FieldProblem {
  /** "displayName", "timeZone", "siteType", "features.<key>", ... */
  field: string;
  reason: string;
}

export type SiteSettingsCheck = { ok: true; settings: SiteSettings } | { ok: false; errors: FieldProblem[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkDisplayName(raw: unknown, errors: FieldProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.push({ field: "displayName", reason: "bad_display_name" });
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function checkTimeZone(raw: unknown, errors: FieldProblem[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw === "") {
    errors.push({ field: "timeZone", reason: "bad_time_zone" });
    return null;
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    errors.push({ field: "timeZone", reason: "bad_time_zone" });
    return null;
  }
  return raw;
}

function checkSiteType(raw: unknown, errors: FieldProblem[]): SiteType | null {
  if (raw === undefined || raw === null) return null;
  if (!isSiteType(raw)) {
    errors.push({ field: "siteType", reason: "bad_site_type" });
    return null;
  }
  return raw;
}

/**
 * Every registry key, filled from `raw` when it is a real boolean, else its
 * own registry default (build rule 5 — a feature the caller never mentioned
 * reads at its default, never `false`). Any key `raw` names that
 * FEATURE_REGISTRY does not list is refused outright: "an unknown feature key
 * ... gets 400", never silently dropped or silently stored.
 */
function checkFeatures(raw: unknown, errors: FieldProblem[]): Record<string, boolean> {
  const out = defaultFeatures();
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    errors.push({ field: "features", reason: "not_an_object" });
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!FEATURE_KEYS.has(key)) {
      errors.push({ field: `features.${key}`, reason: "unknown_feature_key" });
      continue;
    }
    if (typeof value !== "boolean") {
      errors.push({ field: `features.${key}`, reason: "bad_feature_flag" });
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * `raw`: absent or null validates as null (not set — build rule 5). Anything
 * else is validated with alertRules.ts's own `checkSchedule`, the same
 * schedule shape a rule already has, so this file does not invent a second
 * answer for "is this a real schedule". Exported (unlike this file's other
 * per-field checkers) so agent/site-settings.mjs's own POST /open-hours route
 * — a single-field save, separate from the full-settings POST /site-settings
 * — validates the same way rather than re-deriving it.
 */
export function checkOpenHoursField(raw: unknown): { ok: true; openHours: Schedule | null } | { ok: false; reason: string } {
  const errors: FieldProblem[] = [];
  const openHours = checkOpenHoursInner(raw, errors);
  return errors.length > 0 ? { ok: false, reason: (errors[0] as FieldProblem).reason } : { ok: true, openHours };
}

/**
 * Absent or null: the default (build rule 5 — a site that never set this
 * reads 80%, never 0%, which would refuse every match outright). Present
 * must be a finite number in [MIN_APPEARANCE_MATCH_PERCENT,
 * MAX_APPEARANCE_MATCH_PERCENT] — not necessarily an integer (build rule 9:
 * numeric wherever a rate can be fractional; nothing here says a percentage
 * point is the smallest meaningful step).
 */
function checkAppearanceMatchPercent(raw: unknown, errors: FieldProblem[]): number {
  if (raw === undefined || raw === null) return DEFAULT_APPEARANCE_MATCH_PERCENT;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < MIN_APPEARANCE_MATCH_PERCENT ||
    raw > MAX_APPEARANCE_MATCH_PERCENT
  ) {
    errors.push({ field: "appearanceMatchPercent", reason: "bad_appearance_match_percent" });
    return DEFAULT_APPEARANCE_MATCH_PERCENT;
  }
  return raw;
}

function checkOpenHoursInner(raw: unknown, errors: FieldProblem[]): Schedule | null {
  if (raw === undefined || raw === null) return null;
  const checked = checkSchedule(raw);
  if (!checked.ok) {
    errors.push({ field: "openHours", reason: checked.reason });
    return null;
  }
  return checked.schedule;
}

/**
 * Validate a save payload (the whole desired state, not a patch — the same
 * full-replace shape checkCameraAiSettings already uses for one camera's
 * settings), returning EVERY problem at once, never the first alone.
 * `raw` absent or null validates as the full defaults, matching
 * checkCameraAiSettings' own treatment of an absent camera entry.
 */
export function checkSiteSettings(raw: unknown): SiteSettingsCheck {
  if (raw === undefined || raw === null) {
    return { ok: true, settings: defaultSiteSettings() };
  }
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "site", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];
  const displayName = checkDisplayName(raw.displayName, errors);
  const timeZone = checkTimeZone(raw.timeZone, errors);
  const siteType = checkSiteType(raw.siteType, errors);
  const features = checkFeatures(raw.features, errors);
  const openHours = checkOpenHoursInner(raw.openHours, errors);
  const appearanceMatchPercent = checkAppearanceMatchPercent(raw.appearanceMatchPercent, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { displayName, timeZone, siteType, features, openHours, appearanceMatchPercent } };
}

export type SiteSettingsFileCheck =
  | { ok: true; file: SiteSettingsFile }
  | { ok: false; errors: FieldProblem[] };

/**
 * Validate the STORED file (an existing site.json, already on disk) — the
 * settings themselves, plus `updatedUtc`/`updatedBy`. A missing file is never
 * handed to this function: the caller uses `defaultSiteSettings()` directly
 * for an ENOENT, the same split `load()` in agent/camera-ai-settings.mjs
 * already keeps for camera-ai.json.
 */
export function checkSiteSettingsFile(raw: unknown): SiteSettingsFileCheck {
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: "file", reason: "not_an_object" }] };
  }
  const errors: FieldProblem[] = [];
  if (raw.version !== SITE_SETTINGS_VERSION) {
    errors.push({ field: "version", reason: "bad_version" });
  }
  const settingsCheck = checkSiteSettings(raw);
  if (!settingsCheck.ok) errors.push(...settingsCheck.errors);
  let updatedUtc: string | null = null;
  if (typeof raw.updatedUtc === "string" && !Number.isNaN(Date.parse(raw.updatedUtc))) {
    updatedUtc = raw.updatedUtc;
  } else {
    errors.push({ field: "updatedUtc", reason: "bad_time" });
  }
  let updatedBy: string | null = null;
  if (typeof raw.updatedBy === "string" && raw.updatedBy.trim() !== "") {
    updatedBy = raw.updatedBy;
  } else {
    errors.push({ field: "updatedBy", reason: "bad_actor" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    file: {
      version: SITE_SETTINGS_VERSION,
      ...(settingsCheck as { ok: true; settings: SiteSettings }).settings,
      updatedUtc: updatedUtc as string,
      updatedBy: updatedBy as string,
    },
  };
}

/** The settings a validated file (or none at all) hands a reader — every
 *  registry key filled from what is actually stored, defaulted otherwise, so
 *  a feature added to the registry after a site.json was last written never
 *  reads as "off" just because that site.json predates it. */
export function siteSettingsView(file: SiteSettingsFile | null): SiteSettings {
  if (file === null) return defaultSiteSettings();
  const features = defaultFeatures();
  for (const f of FEATURE_REGISTRY) {
    const v = file.features[f.key];
    if (typeof v === "boolean") features[f.key] = v;
  }
  return {
    displayName: file.displayName,
    timeZone: file.timeZone,
    siteType: file.siteType,
    features,
    openHours: file.openHours,
    appearanceMatchPercent: file.appearanceMatchPercent,
  };
}

const SETTINGS_FIELDS = ["displayName", "timeZone", "siteType", "features", "openHours", "appearanceMatchPercent"] as const;

/** Names of the fields that differ, for the audit line — never the values
 *  (the same discipline diffCameraAiSettings already keeps: a changed
 *  feature switch is worth naming, its old and new value is not). */
export function diffSiteSettings(before: SiteSettings, after: SiteSettings): string[] {
  return SETTINGS_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// ---------------------------------------------------------------- presets

/**
 * Apply `siteType`'s preset to `current` — but only when `siteType` is a
 * REAL, NEW choice: "a preset never changes switches silently later: it
 * applies once, when chosen." `siteType` equal to `current.siteType`
 * (including both null — no type chosen at all) is not a new choice, so this
 * returns `current` completely unchanged; a caller may call this on every
 * single save without fear of re-stamping a switch the installer set by hand
 * after the type was last chosen.
 *
 * Only ever writes a feature key FEATURE_REGISTRY lists (build rule: a preset
 * may NAME a future feature — see SITE_TYPE_PRESETS' own comment — but this
 * function never lets that name leak into the stored settings before the
 * feature it belongs to actually exists).
 *
 * `siteType: null` (clearing the site type back to unset) never touches a
 * feature switch either — there is no preset for "no type".
 */
export function applyPreset(current: SiteSettings, siteType: SiteType | null): SiteSettings {
  if (siteType === current.siteType) return current;
  if (siteType === null) return { ...current, siteType: null };
  const preset = SITE_TYPE_PRESETS[siteType];
  const features = { ...current.features };
  for (const f of FEATURE_REGISTRY) {
    if (Object.prototype.hasOwnProperty.call(preset, f.key)) {
      features[f.key] = preset[f.key] as boolean;
    }
  }
  return { ...current, siteType, features };
}

// ---------------------------------------------------------------- effective time zone

/**
 * "`null` means the NVR's own system zone, and the page says which zone that
 * is." `systemTimeZone` is a trusted value the caller already resolved (e.g.
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, the exact call
 * agent/camera-ai-settings.mjs already makes) — never re-derived here, and
 * never validated against Intl a second time: a caller bug that hands in
 * garbage is refused loudly (a TypeError) rather than silently accepted,
 * the same discipline contracts/cameraAiSettings.ts's own checkFloor keeps
 * for a trusted, caller-supplied number.
 */
export function effectiveTimeZone(settings: Pick<SiteSettings, "timeZone">, systemTimeZone: string): string {
  if (typeof systemTimeZone !== "string" || systemTimeZone === "") {
    throw new TypeError(`effectiveTimeZone: systemTimeZone must be a non-empty string, got ${JSON.stringify(systemTimeZone)}`);
  }
  return settings.timeZone ?? systemTimeZone;
}
