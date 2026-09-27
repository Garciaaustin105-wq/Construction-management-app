/**
 * Tenancy: the ownership tree above every NVR -- installer, customer
 * organization, optional group, site (CLOUD-B1-SPEC.md section 1;
 * cloud/CLOUD-SLICE2-SPEC.md). Pure: no fs, no clock, no network. The caller
 * holds the whole tree in memory and passes it in.
 *
 * See cloud/CLOUD-SLICE2-SPEC.md for the full contract
 * each one must satisfy, and cloud/harness/tenancy.harness.mjs for the
 * checks it must pass.
 */

/** One installer account. Oversees its own organizations only -- one
 *  installer never sees another's customers (CLOUD-B1-SPEC.md section 1). */
export interface Installer {
  id: string;
  name: string;
}

/** One customer organization: a chain, a single car wash, a storage
 *  facility, a household -- shapes vary (CLOUD-B1-SPEC.md section 1). */
export interface Org {
  id: string;
  installerId: string;
  name: string;
  /** The installer-video privacy switch (CLOUD-B1-SPEC.md section 3). Off
   *  (`offered: false`) by default -- the client has no switch at all until
   *  the installer turns it on for that client. */
  privacy: { offered: boolean; installerBlocked: boolean };
}

/** An optional region within an org. `parentGroupId` exists in the shape
 *  because nesting was asked about, not because it is supported yet --
 *  `checkTenancy` refuses any group that has one
 *  (`"nested_groups_undecided"`, CLOUD-B1-SPEC.md section 9). */
export interface Group {
  id: string;
  orgId: string;
  parentGroupId: string | null;
  name: string;
}

/** One physical location -- today's `siteId` (CLOUD-B1-SPEC.md section 1). */
export interface Site {
  id: string;
  orgId: string;
  groupId: string | null;
  name: string;
}

/** One NVR (or other claimed device), standing at exactly one site. */
export interface Device {
  deviceId: string;
  siteId: string;
}

/** The whole ownership tree, held in memory by the caller. */
export interface Tenancy {
  installers: Installer[];
  orgs: Org[];
  groups: Group[];
  sites: Site[];
  devices: Device[];
}

/** Why `checkTenancy` flagged one record. */
export type TenancyProblemReason =
  | "duplicate_id"
  | "dangling_reference"
  | "group_org_mismatch"
  | "nested_groups_undecided"
  | "blocked_without_offer"
  | "device_on_two_sites";

/** One problem `checkTenancy` found, and where. */
export type TenancyProblem = { path: string; reason: TenancyProblemReason };

export type CheckTenancyResult = { ok: true } | { ok: false; problems: TenancyProblem[] };

/**
 * Validate a whole tenancy tree, reporting EVERY problem found rather than
 * stopping at the first (build rule 10 -- a caller fixing bad data needs the
 * whole list, not one problem at a time, and rule 16, "say what you could
 * not use, and why"). Pure and total: never throws, never mutates `t`.
 *
 * Contract -- each problem is reported independently; a single record can
 * appear in more than one problem. `path` is always `"<kind>/<id>"` where
 * `<kind>` is the plural field name on `t` (`installers`, `orgs`, `groups`,
 * `sites`, `devices`):
 *
 * - `"duplicate_id"`: two or more records of the same kind share an `id`
 *   (checked for `installers`, `orgs`, `groups` and `sites` -- NOT
 *   `devices`, which has no single `id` field; see `"device_on_two_sites"`
 *   below for that kind). One problem per duplicated id, at
 *   `"<kind>/<id>"`.
 * - `"dangling_reference"`: a reference field points at an id that does not
 *   exist in the kind it references -- `org.installerId`, `group.orgId`,
 *   `group.parentGroupId` (only checked when it is not null), `site.orgId`,
 *   `site.groupId` (only checked when it is not null), or `device.siteId`.
 *   `path` is the record HOLDING the bad reference, e.g. a site with an
 *   unknown `orgId` is reported at `"sites/<that site's id>"`, not at the
 *   missing org.
 * - `"group_org_mismatch"`: a site's `groupId` names a group whose `orgId`
 *   differs from the site's own `orgId`. Only checked when both the site's
 *   org and the site's group resolve (a dangling reference is reported
 *   instead when either does not, and this problem is skipped for that
 *   site). `path` is `"sites/<siteId>"`.
 * - `"nested_groups_undecided"`: a group whose `parentGroupId` is not null,
 *   regardless of whether that parent id resolves. `path` is
 *   `"groups/<groupId>"`.
 * - `"blocked_without_offer"`: an org with `privacy.installerBlocked: true`
 *   while `privacy.offered: false`. `path` is `"orgs/<orgId>"`.
 * - `"device_on_two_sites"`: the same `deviceId` appears more than once in
 *   `t.devices`, whether or not `siteId` differs between occurrences. One
 *   problem per duplicated `deviceId`, at `"devices/<deviceId>"`.
 *
 * Returns `{ ok: true }` when no problem was found, else `{ ok: false,
 * problems }` listing every one, grouped in the order above (all
 * `"duplicate_id"` problems, then all `"dangling_reference"`, and so on).
 * Within a group spanning more than one kind (`"duplicate_id"` can involve
 * `installers`, `orgs`, `groups` or `sites`; `"dangling_reference"` can
 * involve any kind including `devices`), order is first by kind in the
 * fixed sequence `installers, orgs, groups, sites, devices`, then by the
 * order the offending records appear in that kind's own array on `t`.
 */
export function checkTenancy(t: Tenancy): CheckTenancyResult {
  const problems: TenancyProblem[] = [];

  const installerIds = new Set(t.installers.map(i => i.id));
  const orgIds = new Set(t.orgs.map(o => o.id));
  const groupIds = new Set(t.groups.map(g => g.id));
  const siteIds = new Set(t.sites.map(s => s.id));

  const pushDuplicates = (kind: string, records: ReadonlyArray<{ id: string }>): void => {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) duplicated.add(record.id);
      else seen.add(record.id);
    }
    for (const id of duplicated) {
      problems.push({ path: `${kind}/${id}`, reason: "duplicate_id" });
    }
  };
  pushDuplicates("installers", t.installers);
  pushDuplicates("orgs", t.orgs);
  pushDuplicates("groups", t.groups);
  pushDuplicates("sites", t.sites);

  for (const org of t.orgs) {
    if (!installerIds.has(org.installerId)) {
      problems.push({ path: `orgs/${org.id}`, reason: "dangling_reference" });
    }
  }
  for (const group of t.groups) {
    if (!orgIds.has(group.orgId)) {
      problems.push({ path: `groups/${group.id}`, reason: "dangling_reference" });
    }
    if (group.parentGroupId !== null && !groupIds.has(group.parentGroupId)) {
      problems.push({ path: `groups/${group.id}`, reason: "dangling_reference" });
    }
  }
  for (const site of t.sites) {
    if (!orgIds.has(site.orgId)) {
      problems.push({ path: `sites/${site.id}`, reason: "dangling_reference" });
    }
    if (site.groupId !== null && !groupIds.has(site.groupId)) {
      problems.push({ path: `sites/${site.id}`, reason: "dangling_reference" });
    }
  }
  for (const device of t.devices) {
    if (!siteIds.has(device.siteId)) {
      problems.push({ path: `devices/${device.deviceId}`, reason: "dangling_reference" });
    }
  }

  for (const site of t.sites) {
    const groupId = site.groupId;
    if (groupId === null || !groupIds.has(groupId)) continue;
    if (!orgIds.has(site.orgId)) continue;
    const group = t.groups.find(g => g.id === groupId);
    if (group !== undefined && group.orgId !== site.orgId) {
      problems.push({ path: `sites/${site.id}`, reason: "group_org_mismatch" });
    }
  }

  for (const group of t.groups) {
    if (group.parentGroupId !== null) {
      problems.push({ path: `groups/${group.id}`, reason: "nested_groups_undecided" });
    }
  }

  for (const org of t.orgs) {
    if (org.privacy.installerBlocked && !org.privacy.offered) {
      problems.push({ path: `orgs/${org.id}`, reason: "blocked_without_offer" });
    }
  }

  const seenDeviceIds = new Set<string>();
  const duplicatedDeviceIds = new Set<string>();
  for (const device of t.devices) {
    if (seenDeviceIds.has(device.deviceId)) duplicatedDeviceIds.add(device.deviceId);
    else seenDeviceIds.add(device.deviceId);
  }
  for (const deviceId of duplicatedDeviceIds) {
    problems.push({ path: `devices/${deviceId}`, reason: "device_on_two_sites" });
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * The org that owns `siteId`, or `null` when `siteId` is not in `t.sites`
 * or its `orgId` does not resolve to a record in `t.orgs`. Never throws.
 * Does not require `checkTenancy(t)` to have passed -- it is a plain lookup
 * over whatever data is there.
 */
export function orgOfSite(t: Tenancy, siteId: string): Org | null {
  const site = t.sites.find(s => s.id === siteId);
  if (!site) return null;
  const org = t.orgs.find(o => o.id === site.orgId);
  return org ?? null;
}

/**
 * The installer that owns `siteId`'s org, or `null` when `siteId` does not
 * resolve to a site, that site's org does not resolve, or the org's
 * `installerId` does not resolve to a record in `t.installers`. Never
 * throws.
 */
export function installerOfSite(t: Tenancy, siteId: string): Installer | null {
  const site = t.sites.find(s => s.id === siteId);
  if (!site) return null;
  const org = t.orgs.find(o => o.id === site.orgId);
  if (!org) return null;
  const installer = t.installers.find(i => i.id === org.installerId);
  return installer ?? null;
}

/**
 * Every site with `site.orgId === orgId`, in the order they appear in
 * `t.sites`. `[]` when `orgId` is not found or has no sites. Never throws.
 * Membership is by `orgId` directly -- a site belongs to its org regardless
 * of which group, if any, it also sits in (`site.groupId` is a narrower
 * view within the same org, not a separate ownership link).
 */
export function sitesInOrg(t: Tenancy, orgId: string): Site[] {
  const orgExists = t.orgs.some(o => o.id === orgId);
  if (!orgExists) return [];
  return t.sites.filter(site => site.orgId === orgId);
}

/**
 * Every site with `site.groupId === groupId`, in the order they appear in
 * `t.sites`. `[]` when `groupId` is not found or has no sites. Never
 * throws.
 */
export function sitesInGroup(t: Tenancy, groupId: string): Site[] {
  return t.sites.filter(site => site.groupId === groupId);
}
