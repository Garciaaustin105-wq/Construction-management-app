/**
 * Cloud link on the box: the address, the claim code, and what the System
 * page's Cloud section shows (CLOUD-LINK-SPEC.md, section A).
 *
 * Pure: no I/O, no clock of its own (`nowMs` is always a caller-supplied
 * argument — cloudStatusView never reads the real clock). Reading and
 * writing `cloud.json`, `cloud-enrollment.json` and the check-in record
 * belong to agent/ (not this file), the same split contracts/siteSettings.ts
 * already keeps from agent/site-settings.mjs.
 *
 * WHY THIS FILE PARSES A URL BY HAND. This module compiles under this
 * project's `tsconfig.json` with `"lib": ["ES2022"]` and `"types": []` —
 * deliberately no DOM lib and no `@types/node` — so the global `URL` class
 * (a runtime/DOM API, not part of the ECMAScript language `lib.es2022.d.ts`
 * declares) is simply not a name this file can see; `new URL(...)` fails to
 * compile here with `TS2304: Cannot find name 'URL'` (confirmed against this
 * exact tsconfig before writing a line of the parser below). The same
 * discipline already governs contracts/cameraSource.ts's `parseRtspUrl` —
 * "Parsed by hand rather than with `URL`, ... so that reaching for a host
 * API breaks the build rather than the purity guarantee" — and this file
 * follows that file's own shape (authority runs to the first path-starting
 * character; credentials split at the LAST `@` within it) for the same
 * reason: that is how a real URL parser resolves an authority, so a
 * differently-shaped hand parser would accept or refuse a pasted address
 * differently than the box's own browser-based install docs would lead an
 * installer to expect.
 *
 * `parseHttpsUrl` below was built and checked against a REAL `new URL()`
 * (Node's own WHATWG-compliant implementation, run outside this module) for
 * every case that matters to a cloud address an installer would type:
 * scheme case-insensitivity, the WHATWG basic-URL-parser's own leading/
 * trailing-whitespace and embedded-tab/CR/LF preprocessing, a special
 * scheme's authority parsing running even without a literal "//", a
 * backslash ending an authority exactly like a forward slash does, multiple
 * "@" resolving to the LAST one, and the forbidden-host-code-point set that
 * makes a garbled paste (an embedded space, a NUL, a DEL) unparseable rather
 * than silently swallowed into a host string. What it deliberately does NOT
 * attempt — IDNA/punycode host normalisation, percent-decoding, and fully
 * general IPv6-literal grammar inside `[...]` — is called out at
 * `parseHttpsUrl`'s own comment, with the reasoning for why refusing those
 * forms here is the safe direction to differ in (build rule 10: refuse
 * rather than guess), never the dangerous one of accepting a shape a real
 * browser would parse to a different address than the one an installer
 * typed.
 *
 * THE FEARED FAILURES, by name:
 * - `http://` silently treated as good enough, or quietly upgraded to
 *   `https://` — refused outright instead, every time, by scheme (never
 *   "fixed" on the box's behalf).
 * - a URL carrying a username/password (`user:pass@host`) accepted and
 *   later sent as this box's own configured cloud address — refused before
 *   it is ever stored, so it can never reach `cloud.json`, a log line, or a
 *   check-in payload.
 * - a claim code past its `expiresUtc` still shown as if it were live, or
 *   the whole state disappearing instead of saying it expired — codeExpired
 *   is always reported as its own fact; claimCode is hidden once expired,
 *   never silently.
 * - a check-in that has never happened rendering as some default time
 *   (build rule 5 — a blank is not a zero) — `lastCheckinUtc`/`lastOutcome`
 *   are `null`, not a guessed timestamp, until a real check-in record exists.
 * - `enrollUrlOf`/`checkinUrlOf` producing `.../base//enroll` for a cloud
 *   address the installer happened to save with a trailing slash.
 */

// ---------------------------------------------------------------- CloudSettings (cloud.json)

/** What the box keeps in `cloud.json`. A separate file on purpose:
 *  `config.json` holds camera credentials and is never read for this. */
export interface CloudSettings {
  url: string | null;
  enabled: boolean;
}

/** `url: null, enabled: false` — off, and nothing configured: what a box
 *  that has never touched `cloud.json` is running today. */
export const DEFAULT_CLOUD_SETTINGS: Readonly<CloudSettings> = Object.freeze({ url: null, enabled: false });

export type CloudSettingsRefusalReason =
  | "not_an_object"
  | "bad_url"
  | "url_has_credentials"
  | "bad_enabled";

export type CloudSettingsCheck =
  | { ok: true; settings: CloudSettings }
  | { ok: false; reason: CloudSettingsRefusalReason };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** NUL, space, DEL, and the handful of characters no real host or port ever
 *  needs. This is a deliberately partial slice of the WHATWG "forbidden
 *  host code point" set: TAB/LF/CR are already stripped by the whitespace
 *  preprocessing before this is ever checked; '#', '/', '?' and '\\' have
 *  already ended the authority by the time a host string reaches this
 *  (they can never appear in one); ':' and '@' are consumed as the
 *  port/userinfo delimiters by position, not by character class; '[' and
 *  ']' are legitimate IPv6 bracket syntax, checked separately below. What
 *  is left is exactly what would otherwise let a garbled paste (an
 *  embedded space or control character) through as a "host".
 *  Every C0 control (U+0000-U+001F), space, DEL and every C1 control
 *  (U+0080-U+009F) -- a review on 2026-09-28 found ESC, U+0001 and U+0085
 *  getting through when only U+0000 was listed; a real WHATWG parser refuses
 *  all of them. */
const FORBIDDEN_HOST_CHARS = /[\u0000- \u007f-\u009f<>^|]/;

/** The port part (":" plus digits, or a bare ":") is valid only when it is
 *  empty or a number from 0 to 65535, as a real URL parser requires. */
function isValidPortPart(portPart: string): boolean {
  if (!/^:\d*$/.test(portPart)) return false;
  return portPart.length === 1 || Number(portPart.slice(1)) <= 65535;
}

/**
 * `hostPort` is an authority with any userinfo (up to and including the
 * last '@') already stripped off — `host`, `host:port`, `[ipv6]` or
 * `[ipv6]:port`. True when it is non-empty, free of FORBIDDEN_HOST_CHARS,
 * and any port is all ASCII digits (or altogether absent — "host:" with
 * nothing after the colon is a real, if unusual, thing a real `new URL()`
 * also accepts).
 *
 * Deliberately NOT a full IPv6 grammar check (anything between a balanced
 * `[` `]` pair is accepted as-is) and NOT IDNA/percent-decoding-aware — a
 * cloud address is typed once, copied from a dashboard, never extracted
 * from arbitrary camera firmware the way contracts/cameraSource.ts's own
 * parser has to tolerate; going further here would mean re-deriving large
 * parts of the WHATWG host-parsing state machine for cases this box's own
 * installer flow never produces.
 */
function isValidHostPort(hostPort: string): boolean {
  if (hostPort === "" || FORBIDDEN_HOST_CHARS.test(hostPort)) return false;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close === -1) return false; // an unmatched '[' is not a host
    const bracketed = hostPort.slice(0, close + 1);
    if (bracketed === "[]") return false; // an empty bracket pair is not a host
    const portPart = hostPort.slice(close + 1);
    return portPart === "" || isValidPortPart(portPart);
  }
  // The FIRST colon (not the last) ends a non-bracketed host: a second,
  // later colon means the "port" is not all digits, which is exactly what a
  // real `new URL()` refuses too (checked against "https://a:b:80/x", which
  // throws) — using the LAST colon here would wrongly accept it by reading
  // "a:b" as the host.
  const colon = hostPort.indexOf(":");
  if (colon === -1) return true; // no port at all
  const host = hostPort.slice(0, colon);
  if (host === "") return false; // e.g. "https://:8443" — a port with no host
  const portPart = hostPort.slice(colon);
  return isValidPortPart(portPart);
}

type ParsedHttpsUrl = { ok: true; hasCredentials: boolean; cleaned: string } | { ok: false };

/**
 * Whether `raw` is a parseable absolute `https:` URL, and whether its
 * authority carries a `user:pass@` part. See this file's own top comment
 * for why this is hand-written and what it was checked against.
 *
 * `cleaned` (present only on success) is `raw` after the WHATWG basic-URL-
 * parser's own preprocessing — leading/trailing C0-control-or-space
 * stripped, every embedded TAB/CR/LF removed — which is what
 * checkCloudSettings stores, so a value pasted with a stray trailing
 * newline can never reach `cloud.json`, and can never later break
 * enrollUrlOf/checkinUrlOf's own string join.
 */
function parseHttpsUrl(raw: string): ParsedHttpsUrl {
  const s = raw
    .replace(/^[\u0000- ]+/, "")
    .replace(/[\u0000- ]+$/, "")
    .replace(/[\t\r\n]/g, "");

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(s);
  if (schemeMatch === null) return { ok: false }; // no scheme at all — not an absolute URL
  const scheme = (schemeMatch[1] as string).toLowerCase();
  if (scheme !== "https") return { ok: false }; // any other scheme, http included, is bad_url upstream

  // https is a "special" scheme: the Standard parses an authority whether
  // or not "//" actually follows the colon, and skips any run of leading
  // '/' or '\\' there without requiring an exact count — confirmed against
  // a real `new URL()`: "https:host/path", "https:\\host/path" and
  // "https:///host/path" all resolve to host "host", exactly like
  // "https://host/path" does. Requiring a literal "//" here would refuse
  // strings the Standard accepts, which is a shortcut, not a safety margin.
  const afterScheme = s.slice(schemeMatch[0].length);
  const rest = afterScheme.replace(/^[/\\]+/, "");

  // The authority runs to the first '/', '\\', '?' or '#' (a backslash ends
  // it exactly like a forward slash, for a special scheme); credentials
  // split at the LAST '@' within it — both rules match
  // contracts/cameraSource.ts's own parseRtspUrl, which documents the same
  // choice for an rtsp:// authority.
  const authEnd = rest.search(/[/\\?#]/);
  const authority = authEnd === -1 ? rest : rest.slice(0, authEnd);
  const at = authority.lastIndexOf("@");
  // ANY '@' in the authority counts as carrying credentials, even a bare
  // one with nothing meaningful on either side (`https://@host`) — that
  // shape is not one a real cloud address ever needs, and treating it as
  // credentials is the safe direction to be wrong in (build rule 10).
  const hasCredentials = at !== -1;
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  if (!isValidHostPort(hostPort)) return { ok: false };

  return { ok: true, hasCredentials, cleaned: s };
}

/**
 * Validate a `POST /cloud-link` save payload — the whole desired state, not
 * a patch. Every field is required and, unlike checkSiteSettings, a missing
 * or wrongly-typed field is refused rather than quietly defaulted: `url`
 * must be exactly `null` or a valid credential-free `https:` string,
 * `enabled` must be exactly a boolean — an absent key is neither, so it is
 * refused the same as a wrong-typed one (matching contracts/managerRules.ts's
 * own `typeof raw.enabled !== "boolean"` check for the same reason name).
 *
 * `url: null` with `enabled: false` is valid (the default). `enabled: true`
 * with `url: null` is refused as `bad_url` — there is nothing to enable.
 */
export function checkCloudSettings(raw: unknown): CloudSettingsCheck {
  if (!isRecord(raw)) {
    return { ok: false, reason: "not_an_object" };
  }

  let url: string | null;
  if (raw.url === null) {
    url = null;
  } else {
    if (typeof raw.url !== "string") {
      return { ok: false, reason: "bad_url" };
    }
    const parsed = parseHttpsUrl(raw.url);
    if (!parsed.ok) {
      return { ok: false, reason: "bad_url" };
    }
    if (parsed.hasCredentials) {
      return { ok: false, reason: "url_has_credentials" };
    }
    url = parsed.cleaned;
  }

  if (typeof raw.enabled !== "boolean") {
    return { ok: false, reason: "bad_enabled" };
  }
  const enabled = raw.enabled;

  if (enabled && url === null) {
    return { ok: false, reason: "bad_url" };
  }

  return { ok: true, settings: { url, enabled } };
}

// ---------------------------------------------------------------- the two URL helpers

/** `url` with every trailing '/' removed — the shared half of
 *  enrollUrlOf/checkinUrlOf, so both always join at exactly one slash
 *  regardless of how many (zero or more) the stored address happened to
 *  end with. */
function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `url`'s own `/enroll` endpoint. One trailing slash on `url` is tolerated
 *  (and any number more); the join never produces two in a row. */
export function enrollUrlOf(url: string): string {
  return `${stripTrailingSlashes(url)}/enroll`;
}

/** `url`'s own `/checkin` endpoint. Same trailing-slash handling as
 *  enrollUrlOf. */
export function checkinUrlOf(url: string): string {
  return `${stripTrailingSlashes(url)}/checkin`;
}

// ---------------------------------------------------------------- the System page's own view

/**
 * This box's own persisted record of the last enrolment outcome — exactly
 * `agent/cloud-enroll.mjs`'s `CLOUD_ENROLLMENT_FILE` shape (the "never a
 * key, public or private" record: `{ url, deviceId, claimed, claimCode,
 * expiresUtc, atUtc }`). Trusted, already-parsed input: reading and
 * validating the file off disk is the API route's job (CLOUD-LINK-SPEC.md
 * section B), not this pure view.
 */
export interface CloudEnrollmentRecord {
  url: string;
  deviceId: string;
  claimed: boolean;
  claimCode: string | null;
  expiresUtc: string | null;
  atUtc: string;
}

/** `checkin-last.json` (CLOUD-LINK-SPEC.md section C): written after every
 *  check-in attempt, atomically, holding nothing but this. Trusted,
 *  already-parsed input — same split as CloudEnrollmentRecord above. */
export interface CloudCheckinRecord {
  seq: number;
  lastOutcome: string;
  lastAtUtc: string;
}

export type CloudLinkState = "off" | "not_enrolled" | "waiting_for_claim" | "claimed";

export interface CloudStatusView {
  state: CloudLinkState;
  /** From `enrollment`, once one exists — reported regardless of `state`
   *  (build rule 11: report measurements, don't render verdicts), so an
   *  installer who switched the cloud back off can still see which device
   *  this box last enrolled as. */
  deviceId: string | null;
  /** Only while `state` is "waiting_for_claim" AND the code has not
   *  expired — never shown once claimed (the stored record's own claimCode
   *  is already null by then, agent/cloud-enroll.mjs never persists
   *  otherwise) and never shown once expired, even though the state stays
   *  "waiting_for_claim" either way. */
  claimCode: string | null;
  /** Same gating as claimCode's STATE condition, but not its expiry one —
   *  still reported once expired, so the page can say WHEN a hidden code
   *  expired rather than just that it did. */
  codeExpiresUtc: string | null;
  /** A blank is not a zero: `false` whenever there is no code in play at
   *  all (every state but "waiting_for_claim"), never left undefined. */
  codeExpired: boolean;
  /** `null` — not a guessed time — until a real check-in record exists. */
  lastCheckinUtc: string | null;
  lastOutcome: string | null;
}

/**
 * What the System page's Cloud section shows. Pure and clock-free: `nowMs`
 * is the only source of "now" this function ever uses, so a harness (and a
 * later replay of the exact same enrollment+checkin pair) gets a fully
 * deterministic answer regardless of when it actually runs.
 *
 * `state` is driven by `settings.enabled` first, then `enrollment` — "off"
 * whenever the switch is off, whatever `enrollment` says (an installer who
 * disables cloud after enrolling keeps their device id and check-in history
 * on screen, just under a state that says nothing is happening right now).
 */
export function cloudStatusView({
  settings,
  enrollment,
  checkin,
  nowMs,
}: {
  settings: CloudSettings;
  enrollment: CloudEnrollmentRecord | null;
  checkin: CloudCheckinRecord | null;
  nowMs: number;
}): CloudStatusView {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`cloudStatusView: nowMs must be a finite number, got ${JSON.stringify(nowMs)}`);
  }

  const state: CloudLinkState =
    settings.enabled !== true
      ? "off"
      : enrollment === null
        ? "not_enrolled"
        : enrollment.claimed === false
          ? "waiting_for_claim"
          : "claimed";

  const waiting = state === "waiting_for_claim" ? enrollment : null;
  const codeExpiresUtc = waiting !== null ? waiting.expiresUtc : null;
  const codeExpired =
    waiting === null
      ? false
      : codeExpiresUtc === null || Number.isNaN(Date.parse(codeExpiresUtc))
        ? true // no valid expiry to trust: treat as expired rather than show a code that may not be live (build rule 10)
        : Date.parse(codeExpiresUtc) <= nowMs;
  const claimCode = waiting !== null && !codeExpired ? waiting.claimCode : null;

  return {
    state,
    deviceId: enrollment?.deviceId ?? null,
    claimCode,
    codeExpiresUtc,
    codeExpired,
    lastCheckinUtc: checkin?.lastAtUtc ?? null,
    lastOutcome: checkin?.lastOutcome ?? null,
  };
}
