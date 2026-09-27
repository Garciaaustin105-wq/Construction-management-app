/**
 * Scope and permission: which sites a principal can see, and what they may
 * do at one (CLOUD-B1-SPEC.md sections 2-3; cloud/CLOUD-SLICE2-SPEC.md).
 * Pure: no fs, no clock, no network. Sits on top of contracts/tenancy.ts --
 * that file answers "what does the tree look like," this one answers "what
 * can this logged-in person do."
 *
 * See cloud/CLOUD-SLICE2-SPEC.md for the full contract
 * each one must satisfy, and cloud/harness/scope.harness.mjs for the checks
 * it must pass.
 */

import type { Tenancy } from "./tenancy.js";

/** The five human roles plus platform staff (CLOUD-B1-SPEC.md section 2).
 *  `"platform_staff"` is a real value a caller can pass in, not a role that
 *  grants anything -- see `can` below and CLOUD-B1-SPEC.md section 9,
 *  "platform staff" is left undecided. */
export type Role =
  | "installer_tech"
  | "head_office"
  | "regional_manager"
  | "store_manager"
  | "homeowner"
  | "platform_staff";

/** A logged-in user's role and the one place in the tenancy tree it is
 *  scoped to. `scope.kind` names the level, not the role -- `can` checks
 *  that the two agree (`"scope_mismatch"` when they do not). */
export interface Principal {
  userId: string;
  role: Role;
  scope: { kind: "installer" | "org" | "group" | "site"; id: string };
}

/** A capability a principal might hold at one site. */
export type Capability = "health" | "settings" | "video" | "snapshot" | "alerts_optin" | "updates";

/** Why `can` refused a capability. */
export type CanReason =
  | "scope_mismatch"
  | "out_of_scope"
  | "nested_groups_undecided"
  | "homeowner_multi_site"
  | "installer_blocked_by_client"
  | "snapshot_policy_undecided"
  | "installer_only"
  | "platform_staff_undecided";

export type CanResult = { ok: true } | { ok: false; reason: CanReason };

/**
 * Every siteId in `p`'s subtree, sorted ascending as plain strings. Purely
 * structural: driven only by `p.scope` (`kind` + `id`), never by `p.role`
 * -- role only matters to `can`. Never throws; an id that does not resolve
 * yields `[]`, not an error.
 *
 * Every kind first requires `p.scope.id` to resolve to a real record of
 * that kind (`t.sites`, `t.groups`, `t.orgs`, `t.installers`); an id that
 * does not resolve yields `[]`, whatever other records happen to carry the
 * same string. A foreign-key-shaped string is never trusted on its own.
 *
 * Contract, by `p.scope.kind`:
 * - `"site"`: `[p.scope.id]` when that site exists in `t.sites`, else `[]`.
 * - `"group"`: the sites whose `groupId === p.scope.id` AND whose `orgId`
 *   equals that group's own `orgId`. A site filed under a group of a
 *   different org (checkTenancy's `"group_org_mismatch"`) is never visible
 *   through the group -- that would leak one installer's site to another's
 *   regional manager. It stays visible to its own org and installer.
 * - `"org"`: the siteIds of `sitesInOrg(t, p.scope.id)` (sites belonging to
 *   the org directly, per `sitesInOrg`'s own contract, regardless of which
 *   group, if any, they also sit in).
 * - `"installer"`: the union, deduplicated, of the above for every org with
 *   `org.installerId === p.scope.id`.
 *
 * `can` computes the same set, so every rule here applies there too.
 */
export function visibleSites(t: Tenancy, p: Principal): string[] {
  const kind = p.scope.kind;
  const id = p.scope.id;
  switch (kind) {
    case "site":
      return t.sites.some(site => site.id === id) ? [id] : [];
    case "group":
      const group = t.groups.find(g => g.id === id);
      if (!group) return [];
      return t.sites.filter(site => site.groupId === id && site.orgId === group.orgId).map(site => site.id).sort();
    case "org":
      if (!t.orgs.some(org => org.id === id)) return [];
      const orgSites = t.sites.filter(site => site.orgId === id).map(site => site.id);
      return orgSites.sort();
    case "installer":
      if (!t.installers.some(installer => installer.id === id)) return [];
      const orgIds = t.orgs.filter(org => org.installerId === id).map(org => org.id);
      const siteIdsSet = new Set<string>();
      for (const orgId of orgIds) {
        for (const site of t.sites) {
          if (site.orgId === orgId) {
            siteIdsSet.add(site.id);
          }
        }
      }
      const siteIds = Array.from(siteIdsSet);
      return siteIds.sort();
    default:
      return [];
  }
}

/**
 * Whether `p` may exercise `capability` at `siteId`. Pure and total: never
 * throws, and a refusal is always a value, `{ ok: false, reason }`, never
 * an exception (build rule 10).
 *
 * Contract -- checks run in this exact order; the first that applies wins:
 *
 * 1. `"platform_staff_undecided"` when `p.role === "platform_staff"` --
 *    refuses every capability, at every site, before any scope check runs
 *    (CLOUD-B1-SPEC.md section 9: left undecided on purpose).
 * 2. `"scope_mismatch"` when `p.scope.kind` does not match the kind the
 *    role requires: `"installer_tech"` needs `"installer"`; `"head_office"`
 *    and `"homeowner"` need `"org"`; `"regional_manager"` needs `"group"`;
 *    `"store_manager"` needs `"site"`.
 * 3. `"nested_groups_undecided"` when `p.role === "regional_manager"` and
 *    the group named by `p.scope.id` exists in `t.groups` with a non-null
 *    `parentGroupId`. (A `p.scope.id` that does not resolve to any group is
 *    not this reason -- it falls through to `"out_of_scope"` at step 5,
 *    since `visibleSites` then returns `[]`.)
 * 4. `"homeowner_multi_site"` when `p.role === "homeowner"` and
 *    `sitesInOrg(t, p.scope.id).length !== 1`.
 * 5. `"out_of_scope"` when `siteId` is not among `visibleSites(t, p)`.
 *
 * Once `siteId` is confirmed in scope, the org that owns it
 * (`orgOfSite(t, siteId)`) decides the rest:
 *
 * - If `p.role === "installer_tech"` and that org's privacy is
 *   `privacy.offered && privacy.installerBlocked`:
 *   - `capability === "video"` -> `{ ok: false, reason:
 *     "installer_blocked_by_client" }`.
 *   - `capability === "snapshot"` -> `{ ok: false, reason:
 *     "snapshot_policy_undecided" }` (CLOUD-B1-SPEC.md section 9: whether a
 *     snapshot counts as video is undecided, so it is refused rather than
 *     guessed either way).
 *   - every other capability -> `{ ok: true }` (a blocked installer keeps
 *     health, settings, updates, alerts and cameras-online; CLOUD-B1-SPEC.md
 *     section 3).
 * - Otherwise (the principal is not an installer_tech, or the org is not
 *   blocking, or it is blocking but has never been offered the switch):
 *   - `capability === "updates"` and `p.role !== "installer_tech"` -> `{
 *     ok: false, reason: "installer_only" }` (only the installer side ever
 *     manages updates; every chain role and the homeowner are refused).
 *   - every other case -> `{ ok: true }`.
 */
export function can(t: Tenancy, p: Principal, capability: Capability, siteId: string): CanResult {
  // platform staff
  if (p.role === "platform_staff") {
    return { ok: false, reason: "platform_staff_undecided" };
  }

  // scope kind mismatch
  const requiredKind = {
    installer_tech: "installer",
    head_office: "org",
    homeowner: "org",
    regional_manager: "group",
    store_manager: "site",
  }[p.role];
  if (p.scope.kind !== requiredKind) {
    return { ok: false, reason: "scope_mismatch" };
  }

  // nested groups
  if (p.role === "regional_manager") {
    const group = t.groups.find(g => g.id === p.scope.id);
    if (group && group.parentGroupId !== null) {
      return { ok: false, reason: "nested_groups_undecided" };
    }
  }

  // homeowner multi-site
  if (p.role === "homeowner") {
    const orgSites = t.sites
      .filter(s => s.orgId === p.scope.id)
      .map(s => s.id);
    if (orgSites.length !== 1) {
      return { ok: false, reason: "homeowner_multi_site" };
    }
  }

  // compute visible sites
  const visible = visibleSites(t, p);

  if (!visible.includes(siteId)) {
    return { ok: false, reason: "out_of_scope" };
  }

  // find org of site
  const site = t.sites.find(s => s.id === siteId);
  if (!site) {
    return { ok: false, reason: "out_of_scope" };
  }
  const org = t.orgs.find(o => o.id === site.orgId);
  if (!org) {
    return { ok: false, reason: "out_of_scope" };
  }

  // installer privacy block
  if (p.role === "installer_tech" && org.privacy.offered && org.privacy.installerBlocked) {
    if (capability === "video") {
      return { ok: false, reason: "installer_blocked_by_client" };
    }
    if (capability === "snapshot") {
      return { ok: false, reason: "snapshot_policy_undecided" };
    }
    return { ok: true };
  }

  // updates only installer
  if (capability === "updates" && p.role !== "installer_tech") {
    return { ok: false, reason: "installer_only" };
  }

  return { ok: true };

}
