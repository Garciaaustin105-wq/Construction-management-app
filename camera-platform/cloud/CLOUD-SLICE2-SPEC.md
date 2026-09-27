# Cloud slice 2: tenancy and who may see what (pure contracts)

This is CLOUD-B1-SPEC.md sections 1-3, as pure functions. It is
hosting-agnostic. It uses the same layout as CLOUD-SLICE1-SPEC.md: files in
`cloud/contracts/`, tests in `cloud/harness/`.

Owner's decisions (CLOUD-B1-SPEC.md, quoted there):
- Many installers; one installer never sees another's customers.
- A user's scope is a level in the tree, never a hard-coded shape.
- Installers see video by default. Per client, the installer may OFFER a
  privacy switch. Once offered, the client may block installer video. A
  blocked installer keeps health, drives, cameras online, recording status,
  settings, updates and box alerts, and loses live and recorded video.

**Undecided, so refuse rather than guess:**
- **Nested groups:** a group whose parent is a group is refused with
  `"nested_groups_undecided"`.
- **Platform staff:** a principal with role `"platform_staff"` gets NO
  permissions, with the reason `"platform_staff_undecided"`.
- **Snapshots and crops:** whether an event snapshot or crop counts as
  "video" for a blocked installer. Model it as the capability `"snapshot"`,
  kept separate from `"video"`. For a blocked installer, `"snapshot"` is
  refused with the reason `"snapshot_policy_undecided"`, never silently
  allowed.

## contracts/tenancy.ts

- **Types**
  - `Tenancy`: `{ installers: {id,name}[], orgs: {id, installerId, name,
    privacy: {offered: boolean, installerBlocked: boolean}}[], groups:
    {id, orgId, parentGroupId: string|null, name}[], sites: {id, orgId,
    groupId: string|null, name}[], devices: {deviceId, siteId}[] }`.
- **`checkTenancy(t)`** returns `{ ok: true } | { ok: false, problems: {
  path, reason }[] }` and lists EVERY problem:
  - duplicate ids within a kind;
  - a dangling parent reference;
  - a group in a different org than its site;
  - a nested group (`"nested_groups_undecided"`);
  - `installerBlocked: true` while `offered: false` (`"blocked_without_offer"`);
  - a device on two sites.
- **`orgOfSite(t, siteId)`, `installerOfSite(t, siteId)`,
  `sitesInOrg(t, orgId)`, `sitesInGroup(t, groupId)`:** plain lookups that
  return null or [] when the id is not found, never throw.

## contracts/scope.ts

- **`Principal`**: `{ userId, role, scope: { kind: "installer" | "org" |
  "group" | "site", id } }`.
  - Roles: `"installer_tech"`, `"head_office"`, `"regional_manager"`,
    `"store_manager"`, `"homeowner"` and `"platform_staff"`.
  - Each role's scope kind must match: installer_tech with installer;
    head_office and homeowner with org; regional_manager with group;
    store_manager with site. A mismatch is `"scope_mismatch"` and grants
    nothing.
  - A homeowner's org must hold exactly one site, or it is
    `"homeowner_multi_site"`.
- **`visibleSites(t, p)`** returns the sorted siteIds in the principal's
  subtree, or [] with no throw on a bad principal.
- **`can(t, p, capability, siteId)`** returns `{ ok: true } | { ok: false,
  reason }`.
  - Capabilities: `"health"`, `"settings"`, `"video"`, `"snapshot"`,
    `"alerts_optin"`, `"updates"`.
  - A site outside the principal's subtree: `"out_of_scope"`.
  - An installer_tech on a site whose org has `privacy.offered &&
    privacy.installerBlocked`:
    - `"video"` gives `"installer_blocked_by_client"`;
    - `"snapshot"` gives `"snapshot_policy_undecided"`;
    - every other capability is allowed.
  - Chain roles (head_office, regional_manager, store_manager) and the
    homeowner get every capability except `"updates"`, which is
    `"installer_only"`.
  - platform_staff gets `"platform_staff_undecided"` for everything.

**Tests that matter:**
- an installer never sees another installer's site, even with a crafted
  scope id;
- each role and scope-kind mismatch;
- the privacy switch only works when offered;
- a blocked installer keeps health, settings, updates and alerts, and loses
  video, while snapshot stays undecided;
- nested groups are refused;
- a homeowner with two sites is refused;
- platform staff get nothing;
- lookups never throw on unknown ids.
