// cloud/harness/tenancy.harness.mjs — cloud/contracts/tenancy.ts
//
// FEARED: checkTenancy stopping at the first problem instead of listing all
// of them, or crediting a record with a validity it does not have because a
// lookup helper quietly threw instead of returning null/[].

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { checkTenancy, orgOfSite, installerOfSite, sitesInOrg, sitesInGroup } from "../dist/cloud/contracts/tenancy.js";

console.log("tenancy");

// ---- Shared, valid baseline tree. Individual checks copy and mutate this
// rather than share it, so one check's fixture can never leak into another.
function baseline() {
  return {
    installers: [{ id: "inst-1", name: "Acme Install" }],
    orgs: [
      { id: "org-1", installerId: "inst-1", name: "Store Co", privacy: { offered: false, installerBlocked: false } },
    ],
    groups: [{ id: "grp-1", orgId: "org-1", parentGroupId: null, name: "North" }],
    sites: [
      { id: "site-1", orgId: "org-1", groupId: "grp-1", name: "Site One" },
      { id: "site-2", orgId: "org-1", groupId: null, name: "Site Two" },
    ],
    devices: [{ deviceId: "dev-1", siteId: "site-1" }],
  };
}

check("checkTenancy accepts a clean tree", () => {
  same(checkTenancy(baseline()), { ok: true });
});

check("duplicate_id: two installers sharing an id", () => {
  const t = {
    installers: [
      { id: "inst-1", name: "A" },
      { id: "inst-1", name: "B" },
    ],
    orgs: [],
    groups: [],
    sites: [],
    devices: [],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "installers/inst-1", reason: "duplicate_id" }] });
});

check("dangling_reference: an org pointing at an installer that does not exist", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [
      { id: "org-1", installerId: "inst-x", name: "X", privacy: { offered: false, installerBlocked: false } },
    ],
    groups: [],
    sites: [],
    devices: [],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "orgs/org-1", reason: "dangling_reference" }] });
});

check("dangling_reference covers every reference kind, each reported at the holding record", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [
      { id: "org-ok", installerId: "inst-1", name: "OK", privacy: { offered: false, installerBlocked: false } },
      {
        id: "org-bad-installer",
        installerId: "inst-missing",
        name: "Bad",
        privacy: { offered: false, installerBlocked: false },
      },
    ],
    groups: [
      { id: "grp-bad-org", orgId: "org-missing", parentGroupId: null, name: "Bad org" },
      { id: "grp-bad-parent", orgId: "org-ok", parentGroupId: "grp-missing", name: "Bad parent" },
    ],
    sites: [
      { id: "site-bad-org", orgId: "org-missing", groupId: null, name: "Bad org" },
      { id: "site-bad-group", orgId: "org-ok", groupId: "grp-missing", name: "Bad group" },
    ],
    devices: [{ deviceId: "dev-bad-site", siteId: "site-missing" }],
  };
  // grp-bad-parent has a non-null parentGroupId that also happens not to
  // resolve -- build rule: "nested_groups_undecided" fires on any non-null
  // parentGroupId regardless of whether it resolves, so this one record
  // carries both problems.
  same(checkTenancy(t), {
    ok: false,
    problems: [
      { path: "orgs/org-bad-installer", reason: "dangling_reference" },
      { path: "groups/grp-bad-org", reason: "dangling_reference" },
      { path: "groups/grp-bad-parent", reason: "dangling_reference" },
      { path: "sites/site-bad-org", reason: "dangling_reference" },
      { path: "sites/site-bad-group", reason: "dangling_reference" },
      { path: "devices/dev-bad-site", reason: "dangling_reference" },
      { path: "groups/grp-bad-parent", reason: "nested_groups_undecided" },
    ],
  });
});

check("group_org_mismatch: a site's group belongs to a different org than the site", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [
      { id: "org-1", installerId: "inst-1", name: "One", privacy: { offered: false, installerBlocked: false } },
      { id: "org-2", installerId: "inst-1", name: "Two", privacy: { offered: false, installerBlocked: false } },
    ],
    groups: [{ id: "grp-1", orgId: "org-2", parentGroupId: null, name: "Group in org-2" }],
    sites: [{ id: "site-1", orgId: "org-1", groupId: "grp-1", name: "Site in org-1" }],
    devices: [],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "sites/site-1", reason: "group_org_mismatch" }] });
});

check("nested_groups_undecided: a group with a non-null parentGroupId is refused", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [{ id: "org-1", installerId: "inst-1", name: "One", privacy: { offered: false, installerBlocked: false } }],
    groups: [
      { id: "grp-1", orgId: "org-1", parentGroupId: null, name: "Parent" },
      { id: "grp-2", orgId: "org-1", parentGroupId: "grp-1", name: "Child" },
    ],
    sites: [],
    devices: [],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "groups/grp-2", reason: "nested_groups_undecided" }] });
});

check("blocked_without_offer: installerBlocked true while offered is false", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [
      { id: "org-1", installerId: "inst-1", name: "One", privacy: { offered: false, installerBlocked: true } },
    ],
    groups: [],
    sites: [],
    devices: [],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "orgs/org-1", reason: "blocked_without_offer" }] });
});

check("device_on_two_sites: the same deviceId claimed at two sites", () => {
  const t = {
    installers: [{ id: "inst-1", name: "A" }],
    orgs: [{ id: "org-1", installerId: "inst-1", name: "One", privacy: { offered: false, installerBlocked: false } }],
    groups: [],
    sites: [
      { id: "site-a", orgId: "org-1", groupId: null, name: "A" },
      { id: "site-b", orgId: "org-1", groupId: null, name: "B" },
    ],
    devices: [
      { deviceId: "dev-1", siteId: "site-a" },
      { deviceId: "dev-1", siteId: "site-b" },
    ],
  };
  same(checkTenancy(t), { ok: false, problems: [{ path: "devices/dev-1", reason: "device_on_two_sites" }] });
});

check("checkTenancy lists every problem at once, not just the first", () => {
  const t = {
    installers: [
      { id: "inst-1", name: "A" },
      { id: "inst-1", name: "B" },
    ],
    orgs: [
      { id: "org-1", installerId: "inst-1", name: "Blocked", privacy: { offered: false, installerBlocked: true } },
      { id: "org-2", installerId: "inst-1", name: "Two", privacy: { offered: false, installerBlocked: false } },
      { id: "org-3", installerId: "inst-1", name: "Three", privacy: { offered: false, installerBlocked: false } },
      { id: "org-bad", installerId: "inst-missing", name: "Bad", privacy: { offered: false, installerBlocked: false } },
    ],
    groups: [
      { id: "grp-1", orgId: "org-3", parentGroupId: null, name: "In org-3" },
      { id: "grp-2", orgId: "org-2", parentGroupId: "grp-1", name: "Nested" },
    ],
    sites: [
      { id: "site-mismatch", orgId: "org-2", groupId: "grp-1", name: "Mismatched" },
      { id: "site-a", orgId: "org-2", groupId: null, name: "A" },
      { id: "site-b", orgId: "org-2", groupId: null, name: "B" },
    ],
    devices: [
      { deviceId: "dev-1", siteId: "site-a" },
      { deviceId: "dev-1", siteId: "site-b" },
    ],
  };
  same(checkTenancy(t), {
    ok: false,
    problems: [
      { path: "installers/inst-1", reason: "duplicate_id" },
      { path: "orgs/org-bad", reason: "dangling_reference" },
      { path: "sites/site-mismatch", reason: "group_org_mismatch" },
      { path: "groups/grp-2", reason: "nested_groups_undecided" },
      { path: "orgs/org-1", reason: "blocked_without_offer" },
      { path: "devices/dev-1", reason: "device_on_two_sites" },
    ],
  });
});

// ---- lookups ----

check("orgOfSite finds the owning org, and returns null for an unknown site", () => {
  const t = baseline();
  same(orgOfSite(t, "site-1"), t.orgs[0]);
  eq(orgOfSite(t, "site-missing"), null);
});

check("orgOfSite returns null when the site's org does not resolve", () => {
  const t = baseline();
  t.sites[0].orgId = "org-missing";
  eq(orgOfSite(t, "site-1"), null);
});

check("installerOfSite finds the owning installer, and returns null for an unknown site", () => {
  const t = baseline();
  same(installerOfSite(t, "site-1"), t.installers[0]);
  eq(installerOfSite(t, "site-missing"), null);
});

check("installerOfSite returns null when the site's org does not resolve", () => {
  const t = baseline();
  t.sites[0].orgId = "org-missing";
  eq(installerOfSite(t, "site-1"), null);
});

check("installerOfSite returns null when the org's installer does not resolve", () => {
  const t = baseline();
  t.orgs[0].installerId = "inst-missing";
  eq(installerOfSite(t, "site-1"), null);
});

check("sitesInOrg returns every site directly in the org, [] for an unknown org", () => {
  const t = baseline();
  same(sitesInOrg(t, "org-1"), [t.sites[0], t.sites[1]]);
  same(sitesInOrg(t, "org-missing"), []);
});

check("sitesInGroup returns only sites in that group, [] for an unknown group or one with no sites", () => {
  const t = baseline();
  same(sitesInGroup(t, "grp-1"), [t.sites[0]]);
  same(sitesInGroup(t, "grp-missing"), []);
});

report("tenancy");
