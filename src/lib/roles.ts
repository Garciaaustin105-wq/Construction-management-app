// Single source of truth for role taxonomy + role-set helpers.
//
// Roles: crew | superintendent | project_manager | office | sales | accountant
//        | customer | admin | super_admin
//   admin       — org owner; superset of office (can also manage users + org info).
//   super_admin — platform owner (the app operator); null organization_id; sees all orgs.
//   sales       — estimator / pre-sale funnel owner (authors estimates, owns pipeline).
//   accountant  — read-only financials (insights, reports, invoice/customer reads; no writes).
//
// `admin` is folded into the office/management sets so every existing
// office-gated UI/redirect automatically admits admin. `super_admin` is folded
// into OFFICE_LIKE so it is admitted wherever office is, but it also has its
// own platform-only surfaces.
//
// Approach: SINGLE primary role per user + generous role-set gates (Option A).
// A residential/small-GC user who wears several hats (e.g. PM + Superintendent)
// picks one primary role and gains the other's surfaces through the role-set
// gates below (FIELD_MGMT admits both superintendent AND project_manager), so
// no multi-role schema is needed.

export const Role = {
  Crew: "crew",
  Superintendent: "superintendent",
  ProjectManager: "project_manager",
  Office: "office",
  Sales: "sales",
  Accountant: "accountant",
  Customer: "customer",
  Admin: "admin",
  SuperAdmin: "super_admin",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

// All assignable roles (excludes super_admin, which is created via SQL only).
export const ASSIGNABLE_ROLES: Role[] = [
  "crew",
  "superintendent",
  "project_manager",
  "office",
  "sales",
  "accountant",
  "customer",
  "admin",
];

// office-equivalent for UI gating / redirects. admin supersetes office;
// super_admin is admitted wherever office is (plus its own platform surfaces).
export const OFFICE_LIKE = new Set<Role>(["office", "admin", "super_admin"]);

// Management (office / admin / superintendent / project_manager) — used for
// subs/customers read access and the field-team directory.
export const MANAGEMENT = new Set<Role>([
  "office",
  "admin",
  "superintendent",
  "project_manager",
]);

// office + project_manager (PM oversees subs + invoices). admin folds in via
// office; super_admin is added for platform-wide access.
export const OFFICE_OR_PM = new Set<Role>([
  "office",
  "admin",
  "project_manager",
  "super_admin",
]);

// Field capture (crew + superintendent): clock in/out, photos, daily-log +
// punch AUTHORING. Foreman folds in here when added later.
export const FIELD = new Set<Role>(["crew", "superintendent"]);

// Field MANAGEMENT (superintendent + PM + office + admin + super_admin):
// review/approve crew time, review daily logs, manage punch. A PM who also
// runs the site (common in residential/small GC) reaches these surfaces
// through this set without needing a separate superintendent role assignment.
export const FIELD_MGMT = new Set<Role>([
  "superintendent",
  "project_manager",
  "office",
  "admin",
  "super_admin",
]);

// Sales pipeline (sales + PM + office + admin + super_admin): estimate
// authoring + sales-pipeline view. PM/office already authored estimates; sales
// is the dedicated pre-sale role. super_admin for platform-wide access.
export const PIPELINE = new Set<Role>([
  "sales",
  "project_manager",
  "office",
  "admin",
  "super_admin",
]);

// Read-only financials (accountant + office + admin + super_admin): insights,
// reports, invoice/customer reads. Accountant is read-only; the set also
// admits office/admin (who have write access via other gates — membership here
// only gates page ENTRY, not write capability, which RLS enforces separately).
export const ACCOUNTING = new Set<Role>([
  "accountant",
  "office",
  "admin",
  "super_admin",
]);

export const isAdmin = (role: string | null | undefined): boolean =>
  role === "admin";

export const isSuperAdmin = (role: string | null | undefined): boolean =>
  role === "super_admin";

// office-equivalent check for inline guards.
export const isOfficeLike = (role: string | null | undefined): boolean =>
  !!role && OFFICE_LIKE.has(role as Role);

// field-capture check (crew + superintendent).
export const isField = (role: string | null | undefined): boolean =>
  !!role && FIELD.has(role as Role);

// field-management check (super/PM/office/admin/super_admin).
export const isFieldMgmt = (role: string | null | undefined): boolean =>
  !!role && FIELD_MGMT.has(role as Role);

// sales-pipeline check (sales/PM/office/admin/super_admin).
export const isPipeline = (role: string | null | undefined): boolean =>
  !!role && PIPELINE.has(role as Role);

// read-only-financials check (accountant/office/admin/super_admin).
export const isAccounting = (role: string | null | undefined): boolean =>
  !!role && ACCOUNTING.has(role as Role);