/**
 * Who may do what on an appliance.
 *
 * Two kinds of people touch an NVR and they are not the same person.
 *
 * The **installer** commissioned it. They know the camera passwords, chose the
 * drives, set retention. They can break everything, and occasionally must.
 *
 * The **store** uses it every day and did not ask to become an administrator.
 * They need to watch, to find last Tuesday, and to hand a clip to an officer
 * standing at the counter. Handing them the installer's account so they can do
 * that is how a camera ends up unplugged "because it was making noise" and how
 * retention ends up at three days because a setting looked like a slider.
 *
 * So the store account is not a weakened installer. It is a complete account
 * for a different job, and nothing it can reach destroys evidence or
 * reconfigures the box.
 *
 * Two deliberate decisions worth defending:
 *
 * 1. **Retention is installer-only.** It reads like a preference and behaves
 *    like a delete button: lowering it from 30 days to 7 destroys three weeks
 *    of footage, silently, in the background, exactly when someone was about to
 *    go looking for it.
 *
 * 2. **The store CAN export, and CAN hold a segment.** Those are the whole
 *    reason they are standing at the machine. Making them phone the installer
 *    to save a clip is how the clip gets lost — the incident is today and the
 *    callback is Thursday. Both actions are recorded instead of prevented.
 *
 * This module is pure policy. It performs no I/O, hashes nothing and reads no
 * clock: it only answers "may this principal do this thing". The parts that
 * touch secrets live in agent/ where they can be audited separately.
 */

/** A person's account. Devices are not people — see `DisplayPrincipal`. */
export type Role =
  /** Commissioned the box. Full control, including the destructive parts. */
  | "installer"
  /** Uses the box. Everything needed daily, nothing that reconfigures it. */
  | "store";

export type Permission =
  /** Watch the live streams. */
  | "live.view"
  /** Scrub the timeline and play recorded segments. */
  | "playback.view"
  /** Produce a clip file to hand to someone. Recorded in the audit log. */
  | "export.create"
  /** Mark a segment as evidence so retention cannot evict it. */
  | "segment.hold"
  /** Choose the wall layout — which cameras, which grid. */
  | "layout.edit"
  /** Add, remove or re-credential a camera. */
  | "camera.manage"
  /** Drives, retention, eviction. Destroys footage. */
  | "storage.manage"
  /** Network, services, updates, reboot. */
  | "system.manage"
  /** Create and remove accounts, issue display tokens. */
  | "account.manage"
  /** Read the audit log. */
  | "audit.view";

/**
 * Every permission, in one place, so a new one cannot be forgotten below.
 * Frozen: `readonly` stops a TypeScript caller, not a JavaScript one, and a
 * push onto this array would hand the new permission to every installer.
 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze([
  "live.view",
  "playback.view",
  "export.create",
  "segment.hold",
  "layout.edit",
  "camera.manage",
  "storage.manage",
  "system.manage",
  "account.manage",
  "audit.view",
]);

const STORE_PERMISSIONS: readonly Permission[] = Object.freeze([
  "live.view",
  "playback.view",
  "export.create",
  "segment.hold",
  "layout.edit",
]);

/**
 * A wall on a TV is not a person and must not hold a person's account.
 *
 * A screen in a back room runs unattended, boots without anyone present and is
 * physically reachable by whoever is in the room. If it logged in as the store
 * account, then anyone alone with that TV has the store account — including its
 * ability to export footage and to reach the review page for any day.
 *
 * So a display gets its own credential: view-only, no export, no playback,
 * revocable on its own without changing anybody's password.
 */
export interface DisplayPrincipal {
  kind: "display";
  /** Which wall this is, so one can be revoked without disturbing the others. */
  displayId: string;
}

export interface UserPrincipal {
  kind: "user";
  username: string;
  role: Role;
}

/** Nobody has authenticated. Distinct from a user with no permissions. */
export interface AnonymousPrincipal {
  kind: "anonymous";
}

export type Principal = UserPrincipal | DisplayPrincipal | AnonymousPrincipal;

/**
 * What a role may do.
 *
 * Returns a fresh array rather than a shared one: a caller that sorts or
 * filters the result must not be able to edit the policy by accident.
 */
export function permissionsFor(role: Role): Permission[] {
  switch (role) {
    case "installer":
      return [...ALL_PERMISSIONS];
    case "store":
      return [...STORE_PERMISSIONS];
    default: {
      // An unknown role is a bug or a tampered session, never a reason to
      // guess generously.
      const exhaustive: never = role;
      void exhaustive;
      return [];
    }
  }
}

/** A display may only watch. It cannot review, export, or hold. */
const DISPLAY_PERMISSIONS: readonly Permission[] = Object.freeze(["live.view"]);

export function can(principal: Principal, permission: Permission): boolean {
  switch (principal.kind) {
    case "user":
      return permissionsFor(principal.role).includes(permission);
    case "display":
      return DISPLAY_PERMISSIONS.includes(permission);
    case "anonymous":
      return false;
    default: {
      const exhaustive: never = principal;
      void exhaustive;
      return false;
    }
  }
}

export type AccessDecision =
  | { kind: "allow" }
  /** 401: nobody is signed in. The client should present a login. */
  | { kind: "unauthenticated" }
  /** 403: signed in, but not permitted. Says what was missing, not who they are. */
  | { kind: "forbidden"; missing: Permission };

/**
 * The decision an HTTP layer needs, split so it can answer 401 and 403
 * differently — a store account hitting a settings page should be told it is
 * not allowed, not be bounced to a login screen it already passed.
 */
export function authorise(principal: Principal, permission: Permission): AccessDecision {
  if (principal.kind === "anonymous") return { kind: "unauthenticated" };
  if (can(principal, permission)) return { kind: "allow" };
  return { kind: "forbidden", missing: permission };
}

export type PasswordVerdict =
  | { kind: "ok" }
  | { kind: "rejected"; reason: string };

/**
 * The passwords a security appliance must refuse.
 *
 * This list is short and specific on purpose. It is not a strength meter — a
 * meter nags people into `Passw0rd!` and teaches nothing. These are the exact
 * strings that got a generation of cameras enrolled into botnets, and the one
 * this codebase's own bench camera shipped with.
 */
const FORBIDDEN: readonly string[] = [
  "12345",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "password",
  "admin",
  "admin123",
  "camera",
  "hikvision",
  "dahua",
  "nvr",
  "default",
  "changeme",
];

/**
 * Every entry above is shorter than the minimum length, so on its own the list
 * would never fire. What people type to get past a length rule is the same
 * word padded out -- `password1234`, `admin1234567` -- so the check strips the
 * digits and punctuation from both ends first. A password that is nothing BUT
 * digits and punctuation is refused too: `123456789012` is a keyboard row.
 */
const PADDING = /^[\d\s!-/:-@[-`{-~]+|[\d\s!-/:-@[-`{-~]+$/g;

/**
 * Minimum length, not a character-class rule.
 *
 * Forcing a symbol and a digit produces `Summer2024!` on every appliance in the
 * county. Length is the property that actually costs an attacker something, and
 * it is the one an installer standing on a ladder can still satisfy.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(candidate: unknown, username?: string): PasswordVerdict {
  if (typeof candidate !== "string" || candidate === "") {
    return { kind: "rejected", reason: "a password is required" };
  }
  // Trimming is not done for the caller: a password that is all spaces is a
  // typo, and one with a trailing space is a different password than the one
  // they will type tomorrow.
  if (candidate !== candidate.trim()) {
    return { kind: "rejected", reason: "a password cannot begin or end with a space" };
  }
  // Counted in code points, the characters a person types. `.length` counts
  // UTF-16 units, where an emoji is two and six of them would pass as twelve.
  if ([...candidate].length < MIN_PASSWORD_LENGTH) {
    return {
      kind: "rejected",
      reason: `at least ${MIN_PASSWORD_LENGTH} characters — length is what makes a password hard to guess`,
    };
  }
  const lowered = candidate.toLowerCase();
  const core = lowered.replace(PADDING, "");
  if (core === "" || FORBIDDEN.includes(core)) {
    return { kind: "rejected", reason: "that is one of the first passwords anyone tries" };
  }
  // Accounts arrive as JSON: a username that is not a string is compared as
  // nothing rather than crashing the check.
  if (typeof username === "string" && username !== "" && lowered === username.toLowerCase()) {
    return { kind: "rejected", reason: "the password cannot be the username" };
  }
  return { kind: "ok" };
}

/**
 * Whether the appliance still has no way in.
 *
 * A factory default login is the single most exploited thing about this class
 * of hardware, so there is no default account and no default password. A box
 * with no installer account refuses every request except the one that creates
 * the first account — the same activation step the cameras themselves now
 * require, and for the same reason.
 */
export function needsActivation(installerCount: number): boolean {
  return !Number.isInteger(installerCount) || installerCount < 1;
}

/**
 * Can this account be removed?
 *
 * Refusing to delete the last installer is not politeness; an appliance with no
 * installer account cannot be re-credentialled, and the only remaining route in
 * is a site visit with a screwdriver.
 */
export function canRemoveAccount(
  target: { username: string; role: Role },
  installerCount: number,
): { kind: "ok" } | { kind: "refused"; reason: string } {
  // A count that is not a whole number is a bug upstream, and the safe reading
  // of "unknown" is "this might be the last one".
  if (target.role === "installer" && (!Number.isInteger(installerCount) || installerCount <= 1)) {
    return {
      kind: "refused",
      reason: "this is the only installer account — create another before removing this one",
    };
  }
  return { kind: "ok" };
}
