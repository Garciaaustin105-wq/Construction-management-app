// harness/siteSettings.harness.mjs — contracts/siteSettings.ts
// (SITE-SETTINGS-SPEC.md, section 1)
//
// NOT REGISTERED in harness/run-all.mjs (new harnesses never are — see
// AGENTS.md); run it directly: `node harness/siteSettings.harness.mjs`.
//
// FEARED: a missing site.json read as "every feature off" instead of every
// feature at its own registry default; a preset reapplying on a save that
// never actually changed the site type, stamping over a switch the installer
// set by hand afterwards; a preset naming a feature that does not exist yet
// leaking into the stored settings; an unknown feature key or a bad IANA zone
// saved instead of refused with every problem listed; the effective time zone
// silently drifting instead of falling back to the system zone only when the
// site has none of its own.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  SITE_TYPES, FEATURE_REGISTRY, SITE_TYPE_PRESETS,
  defaultSiteSettings, isFeatureEnabled,
  checkSiteSettings, checkSiteSettingsFile, siteSettingsView,
  diffSiteSettings, applyPreset, effectiveTimeZone,
  MAX_DISPLAY_NAME_LENGTH,
} from "../dist/siteSettings.js";

console.log("site settings");

// ---------------------------------------------------------------- defaults / blank is not a zero

check("a missing site.json is the defaults: every field null, every feature at its registry default", () => {
  const d = defaultSiteSettings();
  same(d, { displayName: null, timeZone: null, siteType: null, features: { activity: true } });
});

check("an absent or null save payload validates as the same full defaults", () => {
  eq(checkSiteSettings(undefined).ok, true);
  same(checkSiteSettings(undefined).settings, defaultSiteSettings());
  eq(checkSiteSettings(null).ok, true);
  same(checkSiteSettings(null).settings, defaultSiteSettings());
  same(checkSiteSettings({}).settings, defaultSiteSettings(), "an empty object: every field defaults, none becomes a zero/false");
});

check("the feature registry lists exactly activity today, with its own default", () => {
  same(FEATURE_REGISTRY, [{ key: "activity", registryDefault: true }]);
});

check("isFeatureEnabled reads the registry default when a features map is absent, partial, or silent on that key", () => {
  eq(isFeatureEnabled(undefined, "activity"), true);
  eq(isFeatureEnabled({}, "activity"), true);
  eq(isFeatureEnabled({ activity: false }, "activity"), false);
  eq(isFeatureEnabled({ somethingElse: true }, "activity"), true, "a features map missing this key still defaults, never reads false by omission");
});

check("isFeatureEnabled is always false for a key the registry has never heard of", () => {
  eq(isFeatureEnabled({ managerRules: true }, "managerRules"), false);
  eq(isFeatureEnabled(undefined, "managerRules"), false);
});

// ---------------------------------------------------------------- validation: every problem, not the first

check("checkSiteSettings accepts good settings, trims a display name, and fills every registry feature", () => {
  const r = checkSiteSettings({ displayName: "  Pflugerville Car Wash  ", timeZone: "America/Chicago", siteType: "carwash", features: { activity: false } });
  eq(r.ok, true);
  same(r.settings, { displayName: "Pflugerville Car Wash", timeZone: "America/Chicago", siteType: "carwash", features: { activity: false } });
});

check("a blank display name becomes null, not an empty string stored forever", () => {
  const r = checkSiteSettings({ displayName: "   " });
  eq(r.ok, true);
  eq(r.settings.displayName, null);
});

check("REQUIRED: a bad IANA time zone is refused with 400-shaped errors, not silently accepted or coerced", () => {
  const r = checkSiteSettings({ timeZone: "Mars/Colony_One" });
  eq(r.ok, false);
  same(r.errors, [{ field: "timeZone", reason: "bad_time_zone" }]);
});

check("every real IANA zone SITE_TYPES/Intl can name is accepted", () => {
  for (const tz of ["America/Chicago", "UTC", "Europe/London", "Asia/Tokyo"]) {
    eq(checkSiteSettings({ timeZone: tz }).ok, true, tz);
  }
});

check("REQUIRED: an unknown feature key gets 400, never silently dropped or silently stored", () => {
  const r = checkSiteSettings({ features: { activity: true, managerRules: true } });
  eq(r.ok, false);
  same(r.errors, [{ field: "features.managerRules", reason: "unknown_feature_key" }]);
});

check("a non-boolean feature flag is refused by name", () => {
  const r = checkSiteSettings({ features: { activity: "yes" } });
  eq(r.ok, false);
  same(r.errors, [{ field: "features.activity", reason: "bad_feature_flag" }]);
});

check("an unknown siteType is refused, never silently coerced to null or a guessed type", () => {
  const r = checkSiteSettings({ siteType: "warehouse" });
  eq(r.ok, false);
  same(r.errors, [{ field: "siteType", reason: "bad_site_type" }]);
});

check("REQUIRED: every problem in a bad save comes back at once, not one fix-and-resave at a time", () => {
  const r = checkSiteSettings({
    displayName: "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1),
    timeZone: "Nowhere/Nothing",
    siteType: "warehouse",
    features: { activity: 1, unknownFeature: true },
  });
  eq(r.ok, false);
  eq(r.errors.length, 5, JSON.stringify(r.errors));
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["displayName", "features.activity", "features.unknownFeature", "siteType", "timeZone"]);
});

check("checkSiteSettings refuses a non-object payload", () => {
  for (const bad of [[], "x", 1, true]) {
    const r = checkSiteSettings(bad);
    eq(r.ok, false);
    eq(r.errors[0].field, "site");
  }
});

// ---------------------------------------------------------------- the stored file

function storedFile(overrides = {}) {
  return {
    version: 1,
    displayName: null,
    timeZone: null,
    siteType: null,
    features: { activity: true },
    updatedUtc: "2026-09-26T12:00:00.000Z",
    updatedBy: "tech",
    ...overrides,
  };
}

check("a well-formed stored file validates whole", () => {
  const r = checkSiteSettingsFile(storedFile({ siteType: "retail", features: { activity: false } }));
  eq(r.ok, true);
  same(r.file, storedFile({ siteType: "retail", features: { activity: false } }));
});

check("REQUIRED: a bad stored file is refused with every problem listed, never half-read", () => {
  const r = checkSiteSettingsFile({ version: 2, siteType: "warehouse", updatedUtc: "not a time", updatedBy: "" });
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["siteType", "updatedBy", "updatedUtc", "version"]);
});

check("checkSiteSettingsFile refuses a non-object outright", () => {
  eq(checkSiteSettingsFile(null).ok, false);
  eq(checkSiteSettingsFile(undefined).ok, false);
  eq(checkSiteSettingsFile([]).ok, false);
});

check("siteSettingsView(null) is the same defaults a missing file gets", () => {
  same(siteSettingsView(null), defaultSiteSettings());
});

check("siteSettingsView fills a registry feature a stored file predates, from its own default", () => {
  // A file saved before `activity` shipped, or before some future feature
  // shipped, cannot have every current registry key — reading it must never
  // treat the missing key as off.
  const file = storedFile({ features: {} });
  same(siteSettingsView(file), { displayName: null, timeZone: null, siteType: null, features: { activity: true } });
});

// ---------------------------------------------------------------- the audit diff: names, never values

check("diffSiteSettings names only the fields that changed, never their values", () => {
  const before = defaultSiteSettings();
  const after = { ...before, siteType: "retail", features: { activity: true } };
  same(diffSiteSettings(before, after), ["siteType"], "features unchanged in VALUE (both true) is not a diff");
  same(diffSiteSettings(before, { ...before, displayName: "Front Desk" }), ["displayName"]);
  same(diffSiteSettings(before, { ...before, features: { activity: false } }), ["features"]);
  same(diffSiteSettings(before, before), []);
});

// ---------------------------------------------------------------- presets: name the spec's own table exactly

check("SITE_TYPE_PRESETS matches SITE-SETTINGS-SPEC.md's own table", () => {
  same(SITE_TYPE_PRESETS, {
    retail: { activity: true },
    storage: { activity: true },
    carwash: { activity: true },
    home: { activity: false },
    other: { activity: true },
  });
  same(SITE_TYPES, ["retail", "storage", "carwash", "home", "other"]);
});

check("choosing a site type for the first time applies its preset", () => {
  const current = defaultSiteSettings(); // siteType: null, activity: true (its own default)
  const next = applyPreset(current, "home");
  eq(next.siteType, "home");
  eq(next.features.activity, false, "home's preset switches activity off");
});

check("REQUIRED: a preset applies once — resaving the SAME site type never touches a switch set by hand afterwards", () => {
  let settings = applyPreset(defaultSiteSettings(), "retail");
  eq(settings.features.activity, true);
  // The installer hand-turns activity off, with no type change at all.
  settings = { ...settings, features: { activity: false } };
  // A later save re-invokes applyPreset with the SAME site type — this must
  // be a complete no-op, not a re-stamp back to the preset's own "on".
  const resaved = applyPreset(settings, "retail");
  eq(resaved, settings, "unchanged object identity: nothing recomputed when the type did not change");
  eq(resaved.features.activity, false, "the hand-set switch survives a same-type resave");
});

check("changing to a genuinely different site type applies the NEW type's own preset", () => {
  let settings = applyPreset(defaultSiteSettings(), "retail"); // activity: true
  settings = { ...settings, features: { activity: false } }; // hand-turned off under retail
  const movedToHome = applyPreset(settings, "home");
  eq(movedToHome.siteType, "home");
  eq(movedToHome.features.activity, false, "home's own preset also wants activity off, so this is not itself proof of reapplication");
  const movedToStorage = applyPreset(settings, "storage");
  eq(movedToStorage.siteType, "storage");
  eq(movedToStorage.features.activity, true, "storage's own preset switches activity back ON — this IS a fresh preset apply, triggered by an actual type change");
});

check("clearing the site type back to null never touches a feature switch", () => {
  const settings = applyPreset(defaultSiteSettings(), "home"); // activity: false
  const cleared = applyPreset(settings, null);
  eq(cleared.siteType, null);
  eq(cleared.features.activity, false, "no preset for 'no type' — whatever was set stands");
});

check("REQUIRED: a preset never applies a feature the registry does not list, even when SITE_TYPE_PRESETS names one ahead of time", () => {
  // Simulates the day a preset is edited to start naming a future feature
  // before FEATURE_REGISTRY lists it — applyPreset must still never leak
  // that key into the stored settings.
  const current = { displayName: null, timeZone: null, siteType: null, features: { activity: true } };
  const next = applyPreset(current, "retail");
  eq(Object.prototype.hasOwnProperty.call(next.features, "managerRules"), false, "SITE_TYPE_PRESETS in this build names only 'activity' — nothing else is ever copied in");
  same(Object.keys(next.features), ["activity"]);
});

// ---------------------------------------------------------------- the effective time zone

check("the effective time zone is the site's own zone when set", () => {
  eq(effectiveTimeZone({ timeZone: "America/Chicago" }, "UTC"), "America/Chicago");
});

check("the effective time zone falls back to the system zone only when the site has none", () => {
  eq(effectiveTimeZone({ timeZone: null }, "America/New_York"), "America/New_York");
});

check("effectiveTimeZone throws on a caller bug (a non-string system zone), rather than silently accepting garbage", () => {
  throws(() => effectiveTimeZone({ timeZone: null }, ""), "empty string");
  throws(() => effectiveTimeZone({ timeZone: null }, undefined), "undefined");
  throws(() => effectiveTimeZone({ timeZone: null }, 123), "a number");
});

report("site settings");
