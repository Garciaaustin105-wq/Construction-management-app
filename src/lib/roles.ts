// Single source of truth for role taxonomy + role-set helpers.
//
// Roles: crew | superintendent | project_manager | office | customer | admin | super_admin
//   admin       — org owner; superset of office (can also manage users + org info).
//   super_admin — platform owner (the app operator); null organization_id; sees all orgs.
//
// `admin` is folded into the office/management sets so every existing
// office-gated UI/redirect automatically admits admin. `super_admin` is folded
// into OFFICE_LIKE so it is admitted wherever office is, but it also has its
// own platform-only surfaces.

export const Role = {
  Crew: "crew",
  Superintendent: "superintendent",
  ProjectManager: "project_manager",
  Office: "office",
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

export const isAdmin = (role: string | null | undefined): boolean =>
  role === "admin";

export const isSuperAdmin = (role: string | null | undefined): boolean =>
  role === "super_admin";

// office-equivalent check for inline guards.
export const isOfficeLike = (role: string | null | undefined): boolean =>
  !!role && OFFICE_LIKE.has(role as Role);