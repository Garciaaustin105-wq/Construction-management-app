// cloud/harness/scope.harness.mjs — cloud/contracts/scope.ts
//
// FEARED: a scope check that lets one installer reach another's site through
// a crafted or stale scope id, or a privacy-block check that fires for a
// role it was never meant to touch (chain staff, not just the installer).

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { visibleSites, can } from "../dist/cloud/contracts/scope.js";

console.log("scope");

// ---- Shared tenancy fixture. Two installers (A, B) so cross-installer
// isolation is testable; a nested group under installer A; a blocked org
// (offered + blocked) and a blocked-but-never-offered org, to separate the
// two; and two homeowner orgs, one single-site and one multi-site.
function fixture() {
  return {
    installers: [
      { id: "inst-A", name: "Installer A" },
      { id: "inst-B", name: "Installer B" },
    ],
    orgs: [
      { id: "org-A1", installerId: "inst-A", name: "A1", privacy: { offered: false, installerBlocked: false } },
      { id: "org-A2", installerId: "inst-A", name: "A2 blocked", privacy: { offered: true, installerBlocked: true } },
      {
        id: "org-A3",
        installerId: "inst-A",
        name: "A3 blocked-not-offered",
        privacy: { offered: false, installerBlocked: true },
      },
      { id: "org-home1", installerId: "inst-A", name: "Home1", privacy: { offered: false, installerBlocked: false } },
      { id: "org-home2", installerId: "inst-A", name: "Home2", privacy: { offered: false, installerBlocked: false } },
      { id: "org-B1", installerId: "inst-B", name: "B1", privacy: { offered: false, installerBlocked: false } },
    ],
    groups: [
      { id: "grp-A1", orgId: "org-A1", parentGroupId: null, name: "Region A1" },
      { id: "grp-nested", orgId: "org-A1", parentGroupId: "grp-A1", name: "Nested" },
    ],
    sites: [
      { id: "site-A1-1", orgId: "org-A1", groupId: "grp-A1", name: "A1-1" },
      { id: "site-A1-2", orgId: "org-A1", groupId: null, name: "A1-2" },
      { id: "site-A2-1", orgId: "org-A2", groupId: null, name: "A2-1" },
      { id: "site-A3-1", orgId: "org-A3", groupId: null, name: "A3-1" },
      { id: "site-home1", orgId: "org-home1", groupId: null, name: "Home1" },
      { id: "site-home2a", orgId: "org-home2", groupId: null, name: "Home2a" },
      { id: "site-home2b", orgId: "org-home2", groupId: null, name: "Home2b" },
      { id: "site-B1-1", orgId: "org-B1", groupId: null, name: "B1-1" },
    ],
    devices: [],
  };
}

// ---- visibleSites ----

check("visibleSites: site scope is just that one site, or [] unknown", () => {
  const t = fixture();
  same(visibleSites(t, { userId: "u", role: "store_manager", scope: { kind: "site", id: "site-A1-1" } }), [
    "site-A1-1",
  ]);
  same(visibleSites(t, { userId: "u", role: "store_manager", scope: { kind: "site", id: "site-missing" } }), []);
});

check("visibleSites: group scope is the sites in that group, or [] unknown/empty", () => {
  const t = fixture();
  same(visibleSites(t, { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-A1" } }), [
    "site-A1-1",
  ]);
  same(visibleSites(t, { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-missing" } }), []);
});

check("visibleSites: org scope is every site directly in the org, sorted", () => {
  const t = fixture();
  same(visibleSites(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-A1" } }), [
    "site-A1-1",
    "site-A1-2",
  ]);
  same(visibleSites(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-missing" } }), []);
});

check("visibleSites: installer scope unions every org's sites, sorted, deduplicated", () => {
  const t = fixture();
  same(visibleSites(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } }), [
    "site-A1-1",
    "site-A1-2",
    "site-A2-1",
    "site-A3-1",
    "site-home1",
    "site-home2a",
    "site-home2b",
  ]);
  same(visibleSites(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-B" } }), [
    "site-B1-1",
  ]);
  same(visibleSites(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-missing" } }), []);
});

// ---- can(): scope-kind mismatch, one per role ----

check("can refuses every role whose scope.kind does not match what the role requires", () => {
  const t = fixture();
  same(
    can(t, { userId: "u", role: "installer_tech", scope: { kind: "org", id: "org-A1" } }, "health", "site-A1-1"),
    { ok: false, reason: "scope_mismatch" },
  );
  same(
    can(t, { userId: "u", role: "head_office", scope: { kind: "site", id: "site-A1-1" } }, "health", "site-A1-1"),
    { ok: false, reason: "scope_mismatch" },
  );
  same(
    can(t, { userId: "u", role: "regional_manager", scope: { kind: "org", id: "org-A1" } }, "health", "site-A1-1"),
    { ok: false, reason: "scope_mismatch" },
  );
  same(
    can(t, { userId: "u", role: "store_manager", scope: { kind: "group", id: "grp-A1" } }, "health", "site-A1-1"),
    { ok: false, reason: "scope_mismatch" },
  );
  same(
    can(t, { userId: "u", role: "homeowner", scope: { kind: "site", id: "site-home1" } }, "health", "site-home1"),
    { ok: false, reason: "scope_mismatch" },
  );
});

// ---- can(): platform staff ----

check("can refuses platform_staff for every capability, regardless of scope shape", () => {
  const t = fixture();
  const p = { userId: "u", role: "platform_staff", scope: { kind: "org", id: "org-A1" } };
  for (const capability of ["health", "settings", "video", "snapshot", "alerts_optin", "updates"]) {
    same(can(t, p, capability, "site-A1-1"), { ok: false, reason: "platform_staff_undecided" });
  }
});

// ---- can(): installer isolation ----

check("an installer_tech never reaches another installer's site, even scoped at that installer's own id", () => {
  const t = fixture();
  same(
    can(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } }, "health", "site-B1-1"),
    { ok: false, reason: "out_of_scope" },
  );
  same(
    can(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-B" } }, "health", "site-A1-1"),
    { ok: false, reason: "out_of_scope" },
  );
  same(
    can(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } }, "health", "site-A1-1"),
    { ok: true },
  );
});

// ---- can(): privacy switch only works once offered ----

check("a blocked-but-never-offered org does not restrict the installer at all", () => {
  const t = fixture();
  const p = { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } };
  same(can(t, p, "video", "site-A3-1"), { ok: true });
  same(can(t, p, "snapshot", "site-A3-1"), { ok: true });
});

// ---- can(): a blocked, offered org restricts only video/snapshot ----

check("an offered-and-blocked org keeps health/settings/updates/alerts for the installer, loses video, snapshot undecided", () => {
  const t = fixture();
  const p = { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } };
  same(can(t, p, "health", "site-A2-1"), { ok: true });
  same(can(t, p, "settings", "site-A2-1"), { ok: true });
  same(can(t, p, "alerts_optin", "site-A2-1"), { ok: true });
  same(can(t, p, "updates", "site-A2-1"), { ok: true });
  same(can(t, p, "video", "site-A2-1"), { ok: false, reason: "installer_blocked_by_client" });
  same(can(t, p, "snapshot", "site-A2-1"), { ok: false, reason: "snapshot_policy_undecided" });
});

check("the installer privacy block never touches the org's own chain staff", () => {
  const t = fixture();
  const headOffice = { userId: "u", role: "head_office", scope: { kind: "org", id: "org-A2" } };
  same(can(t, headOffice, "video", "site-A2-1"), { ok: true });
  same(can(t, headOffice, "snapshot", "site-A2-1"), { ok: true });
  same(can(t, headOffice, "updates", "site-A2-1"), { ok: false, reason: "installer_only" });
});

// ---- can(): nested groups refused ----

check("a regional_manager scoped at a nested group is refused, before scope is even checked", () => {
  const t = fixture();
  const p = { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-nested" } };
  same(can(t, p, "health", "site-A1-1"), { ok: false, reason: "nested_groups_undecided" });
  same(can(t, p, "health", "site-missing"), { ok: false, reason: "nested_groups_undecided" });
});

check("a regional_manager scoped at a non-nested group works normally, and only within that group", () => {
  const t = fixture();
  const p = { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-A1" } };
  same(can(t, p, "health", "site-A1-1"), { ok: true });
  same(can(t, p, "updates", "site-A1-1"), { ok: false, reason: "installer_only" });
  same(can(t, p, "health", "site-A1-2"), { ok: false, reason: "out_of_scope" });
});

// ---- can(): homeowner with more than one site is refused ----

check("a homeowner whose org holds two sites is refused, even for a site that really is theirs", () => {
  const t = fixture();
  const p = { userId: "u", role: "homeowner", scope: { kind: "org", id: "org-home2" } };
  same(can(t, p, "health", "site-home2a"), { ok: false, reason: "homeowner_multi_site" });
  same(can(t, p, "video", "site-home2b"), { ok: false, reason: "homeowner_multi_site" });
});

check("a homeowner whose org holds exactly one site works normally", () => {
  const t = fixture();
  const p = { userId: "u", role: "homeowner", scope: { kind: "org", id: "org-home1" } };
  same(can(t, p, "health", "site-home1"), { ok: true });
  same(can(t, p, "video", "site-home1"), { ok: true });
  same(can(t, p, "updates", "site-home1"), { ok: false, reason: "installer_only" });
});

// ---- can(): lookups never throw on unknown ids ----

check("can never throws on an unresolvable scope or site id -- it refuses out_of_scope instead", () => {
  const t = fixture();
  same(
    can(t, { userId: "u", role: "store_manager", scope: { kind: "site", id: "site-missing" } }, "health", "site-missing"),
    { ok: false, reason: "out_of_scope" },
  );
  same(
    can(
      t,
      { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-missing" } },
      "health",
      "site-A1-1",
    ),
    { ok: false, reason: "out_of_scope" },
  );
  same(
    can(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-missing" } }, "health", "site-A1-1"),
    { ok: false, reason: "out_of_scope" },
  );
});

// ---- Review findings (2026-09-27): a foreign-key-shaped string is never
// trusted on its own. These were written to FAIL against the first build.

check("a site filed under another installer's group is invisible to that group's regional manager", () => {
  const t = fixture();
  // Installer B's site, wrongly filed under installer A's group (the
  // tenancy tree checkTenancy calls group_org_mismatch).
  t.sites.push({ id: "site-B1-stray", orgId: "org-B1", groupId: "grp-A1", name: "stray" });
  const rm = { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-A1" } };
  same(visibleSites(t, rm), ["site-A1-1"]);
  same(can(t, rm, "health", "site-B1-stray"), { ok: false, reason: "out_of_scope" });
  same(can(t, rm, "video", "site-B1-stray"), { ok: false, reason: "out_of_scope" });
  // Its own org and installer still see it.
  same(visibleSites(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-B1" } }), [
    "site-B1-1",
    "site-B1-stray",
  ]);
  same(
    can(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-B" } }, "video", "site-B1-stray"),
    { ok: true },
  );
});

check("an installer or org scope id that resolves to no record sees nothing, even if orgs or sites carry that string", () => {
  const t = fixture();
  // An org and site pointing at an installer that does not exist, and a
  // site pointing at an org that does not exist.
  t.orgs.push({ id: "org-ghost", installerId: "inst-ghost", name: "Ghost", privacy: { offered: false, installerBlocked: false } });
  t.sites.push({ id: "site-ghost-1", orgId: "org-ghost", groupId: null, name: "Ghost-1" });
  t.sites.push({ id: "site-orphan-1", orgId: "org-orphan", groupId: null, name: "Orphan-1" });
  const ghostInstaller = { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-ghost" } };
  same(visibleSites(t, ghostInstaller), []);
  same(can(t, ghostInstaller, "health", "site-ghost-1"), { ok: false, reason: "out_of_scope" });
  same(visibleSites(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-orphan" } }), []);
});

check("org, group and installer results are sorted even when the input is not", () => {
  const t = fixture();
  // Lexically first, inserted last.
  t.sites.push({ id: "site-A1-0", orgId: "org-A1", groupId: "grp-A1", name: "A1-0" });
  same(visibleSites(t, { userId: "u", role: "head_office", scope: { kind: "org", id: "org-A1" } }), [
    "site-A1-0",
    "site-A1-1",
    "site-A1-2",
  ]);
  same(visibleSites(t, { userId: "u", role: "regional_manager", scope: { kind: "group", id: "grp-A1" } }), [
    "site-A1-0",
    "site-A1-1",
  ]);
  same(visibleSites(t, { userId: "u", role: "installer_tech", scope: { kind: "installer", id: "inst-A" } }), [
    "site-A1-0",
    "site-A1-1",
    "site-A1-2",
    "site-A2-1",
    "site-A3-1",
    "site-home1",
    "site-home2a",
    "site-home2b",
  ]);
});

check("a homeowner whose org holds zero sites is refused homeowner_multi_site, not out_of_scope", () => {
  const t = fixture();
  t.orgs.push({ id: "org-home0", installerId: "inst-A", name: "Home0", privacy: { offered: false, installerBlocked: false } });
  const p = { userId: "u", role: "homeowner", scope: { kind: "org", id: "org-home0" } };
  same(can(t, p, "health", "site-home1"), { ok: false, reason: "homeowner_multi_site" });
  same(can(t, p, "health", "site-missing"), { ok: false, reason: "homeowner_multi_site" });
});

report("scope");
