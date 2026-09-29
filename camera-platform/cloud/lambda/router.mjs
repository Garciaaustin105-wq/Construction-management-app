// cloud/lambda/router.mjs — the single Lambda entry point (CLOUD-AWS-SPEC.md
// section B). One Lambda serves every route (API Gateway HTTP API, payload
// format 2.0): POST /enroll, POST /checkin, POST /claim, GET /fleet,
// POST /login, POST /logout.
//
// `createRouter(deps)` wires the same six handlers cloud/dev/server.mjs
// wires (cloud/api/enroll.mjs, cloud/api/checkin.mjs, cloud/api/claim.mjs,
// cloud/api/fleet.mjs, cloud/api/login.mjs's loginHandler/logoutHandler),
// with PRODUCTION deps only — copied from cloud/dev/server.mjs's own
// wiring, MINUS every dev-only piece: no dev bearer token, no site-dev
// placement glue, no loopback/TLS listener. `handler` below is the actual
// Lambda entry point: it builds one router per cold start over the real
// DynamoDB store and reuses it for every invocation that cold start serves.
//
// This file owns event normalization, routing, the 413/404/500 status
// table, and the `set-cookie` -> `cookies` mapping (CLOUD-AWS-SPEC.md
// section B, "Response out"). Every rule that actually decides anything —
// verifying an enrolment, checking a signed check-in, claiming a code,
// scoping a fleet listing, checking a password — already lives in the
// handlers and the pure contracts underneath them; this file is glue, like
// cloud/dev/server.mjs, just for API Gateway instead of a loopback https
// listener.

import { randomInt, verify as cryptoVerify } from "node:crypto";

import { handler as enrollHandler } from "../api/enroll.mjs";
import { handler as checkinHandler } from "../api/checkin.mjs";
import { handler as claimHandler } from "../api/claim.mjs";
import { handler as fleetHandler } from "../api/fleet.mjs";
import { loginHandler, logoutHandler, principalFromEvent } from "../api/login.mjs";

/** The largest a request body may be before this router refuses it outright
 *  with a 413, in bytes of the DECODED body text — CLOUD-AWS-SPEC.md section
 *  B: "A body over 16 KB (the dev server's limit) -> 413 payload_too_large
 *  before any handler runs." Checked here, once, before any route is even
 *  matched — a device's own tighter per-handler limit (cloud/api/checkin.mjs's
 *  64 KB MAX_BODY_BYTES, for instance) never gets a chance to see anything
 *  this ceiling already refused. */
export const MAX_BODY_BYTES = 16 * 1024;

/** How far a `sentAtUtc` may drift from this router's own clock before an
 *  enrolment is refused, in milliseconds — the SAME 5-minute tolerance
 *  cloud/contracts/checkinVerify.ts hard-codes as CLOCK_SKEW_LIMIT_MS for a
 *  check-in (cloud/dev/server.mjs's own ENROLL_MAX_SKEW_MS carries the exact
 *  same value and the exact same reasoning): CLOUD-AWS-SPEC.md names no
 *  separate value for enrolment, and inventing a different number for the
 *  same kind of clock-skew tolerance would be a guess, not a decision (build
 *  rule 10). Kept as this router's own constant (not a dev-only piece) —
 *  every caller of cloud/contracts/enroll.ts needs SOME maxSkewMs. */
const ENROLL_MAX_SKEW_MS = 300000;

/**
 * Real Ed25519 signature verification via node:crypto — copied from
 * cloud/dev/server.mjs's own `verifySignature` (pure crypto, not dev-only
 * glue): the one function every handler's `deps.verifySignature` is,
 * whatever name its own JSDoc gives its first argument. A `verifySignature`
 * that itself throws is treated as `false`, never propagated — both
 * `verifyEnrollment` and `verifyCheckin` already assume that independently.
 *
 * @param {string} signedText
 * @param {string} signatureB64
 * @param {string} publicKeyPem
 * @returns {boolean}
 */
function verifySignature(signedText, signatureB64, publicKeyPem) {
  try {
    return cryptoVerify(null, Buffer.from(signedText, "utf8"), publicKeyPem, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** `deps.randomValues(n)` for cloud/api/enroll.mjs: `n` fresh integers, each
 *  in `0..31`, via `crypto.randomInt(32)` — copied from
 *  cloud/dev/server.mjs's own `randomValues`. Real randomness, never a
 *  harness's deterministic queue. */
function randomValues(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(randomInt(32));
  return out;
}

/**
 * The message text of a thrown value, never the value itself — used only
 * for the one-line 500 log (CLOUD-AWS-SPEC.md section B: "logged as one
 * line with the route and the error message only. Never the event, the
 * body or the headers").
 *
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * API Gateway HTTP API payload 2.0 event -> the plain fields every handler
 * here actually needs (CLOUD-AWS-SPEC.md section B, "Event in"):
 *  - `body`: base64-decoded when `isBase64Encoded`, else the string, else `""`.
 *  - `headers`: lower-cased names (API Gateway already sends them so; this
 *    still lower-cases defensively rather than trusting it blindly).
 *  - `event.cookies` (the array 2.0 uses instead of a `cookie` header) is
 *    joined with `"; "` into `headers.cookie` — a cookie that instead
 *    arrived already folded into a header (a proxy in front of API Gateway,
 *    say) is left exactly as it came.
 *  - `sourceIp` from `requestContext.http.sourceIp`.
 *  - `routeKey`: the field API Gateway routes by, used for dispatch below.
 *
 * @param {Record<string, any>} event
 */
function normalizeEvent(event) {
  const routeKey =
    typeof event?.routeKey === "string" && event.routeKey.length > 0
      ? event.routeKey
      : `${event?.requestContext?.http?.method ?? ""} ${event?.rawPath ?? ""}`;
  const sourceIp = event?.requestContext?.http?.sourceIp ?? "";

  const headers = {};
  for (const [name, value] of Object.entries(event?.headers ?? {})) {
    if (typeof name === "string") headers[name.toLowerCase()] = value;
  }
  if (Array.isArray(event?.cookies) && event.cookies.length > 0) {
    headers.cookie = event.cookies.join("; ");
  }

  const body = event?.isBase64Encoded
    ? Buffer.from(typeof event?.body === "string" ? event.body : "", "base64").toString("utf8")
    : typeof event?.body === "string"
      ? event.body
      : "";

  const bodyTooLarge = Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES;

  return { routeKey, sourceIp, headers, body, bodyTooLarge };
}

/**
 * A handler's own `{ statusCode, headers, body }` -> the API Gateway 2.0
 * response shape (CLOUD-AWS-SPEC.md section B, "Response out"): a
 * `set-cookie` response header is moved into a top-level `cookies` array —
 * the 2.0 format's own way of setting cookies — and never left behind in
 * `headers`.
 *
 * @param {{statusCode: number, headers: Record<string,string>, body: string}} result
 */
function toGatewayResponse(result) {
  const headers = { ...(result.headers ?? {}) };
  const setCookie = headers["set-cookie"];
  const response = { statusCode: result.statusCode, headers, body: result.body };
  if (typeof setCookie === "string") {
    delete headers["set-cookie"];
    response.cookies = [setCookie];
  }
  return response;
}

const respondJson = (statusCode, payload) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/**
 * `deps` this router needs (CLOUD-AWS-SPEC.md section B):
 * @typedef {Object} RouterDeps
 * @property {import("../api/store.mjs").Store} store
 * @property {() => number} nowMs
 * @property {(n: number) => Buffer} randomBytes
 * @property {(entry: Record<string, unknown>) => void} log
 *   One JSON-serializable entry per request, tagged with `route`. A 500's
 *   entry has `route` and `message` only — never the event, body, headers
 *   or cookies (they carry passwords, cookies and claim codes).
 * @property {{N: number, r: number, p: number}} [scryptParams]
 *   Passed through to the login deps unchanged; tests use a cheap one.
 */

/**
 * Build one `route(event) -> Promise<{statusCode, headers, body, cookies?}>`
 * over the given `deps`, testable with the memory store (CLOUD-AWS-SPEC.md
 * section B). Every route handler below gets exactly the deps
 * cloud/dev/server.mjs gives it, minus every dev-only piece: no dev token,
 * no site-dev glue. `allowOpenEnrollment: true` is the owner's OWN
 * production decision (CLOUD-AWS-SPEC.md section B), not a dev-only
 * shortcut, so it is set here too. `principalOf` for `/claim` and `/fleet`
 * is `(event) => principalFromEvent(normalizedEvent, loginDeps)` — it
 * ignores whatever event the handler itself passes in and always resolves
 * the principal from THIS request's own normalized headers, so an error the
 * store throws while resolving a session surfaces as this request's 500 (via
 * the handler's own un-caught `await deps.principalOf(event)`), never as a
 * silently swallowed 401.
 *
 * @param {RouterDeps} deps
 * @returns {(event: Record<string, any>) => Promise<{statusCode: number, headers: Record<string,string>, body: string, cookies?: string[]}>}
 */
export function createRouter(deps) {
  const { store, nowMs, randomBytes, log, scryptParams } = deps;

  const enrollDeps = {
    store,
    nowMs,
    verifySignature,
    randomValues,
    allowOpenEnrollment: true, // CLOUD-AWS-SPEC.md section B: the owner's own production decision.
    maxSkewMs: ENROLL_MAX_SKEW_MS,
    log: (entry) => log({ route: "enroll", reason: entry?.reason ?? null, deviceId: entry?.deviceId ?? null }),
  };
  const checkinDeps = {
    store,
    nowMs,
    verifySignature,
    principalOf: () => null, // a check-in authenticates by signature, never a principal.
    log: (entry) => log({ route: "checkin", reason: entry?.reason ?? null, deviceId: entry?.deviceId ?? null }),
  };
  const claimDeps = {
    store,
    nowMs,
    verifySignature, // present for a uniform deps shape; claim.mjs never calls it.
    log: (entry) => log({ route: "claim", reason: entry?.reason ?? null, deviceId: entry?.deviceId ?? null }),
  };
  const fleetDeps = {
    store,
    nowMs,
    verifySignature, // present for a uniform deps shape; fleet.mjs never calls it.
    log: (entry) => log({ route: "fleet", reason: entry?.reason ?? null, deviceId: entry?.deviceId ?? null }),
  };
  // deps.scryptParams is passed through unchanged (undefined in production,
  // hashing and verifying at the same cost a real login pays — a cheap one
  // only when a caller injects it, exactly like cloud/dev/server.mjs).
  const loginDeps = {
    store,
    nowMs,
    randomBytes,
    scryptParams,
    log: (entry) => log({ route: entry?.route ?? "login", reason: entry?.reason ?? null, userId: entry?.userId ?? null }),
  };

  return async function route(rawEvent) {
    const normalized = normalizeEvent(rawEvent);

    // 413 over 16 KB, before any handler (or store call) runs at all —
    // checked ahead of routing, so it applies uniformly to every route.
    if (normalized.bodyTooLarge) {
      return respondJson(413, { ok: false, reason: "payload_too_large" });
    }

    // principalOf for /claim and /fleet: always resolved from THIS request's
    // own normalized headers, never from whatever event the handler itself
    // hands back in — see the file-level doc comment above.
    const sessionEvent = { headers: normalized.headers };
    const principalOf = () => principalFromEvent(sessionEvent, loginDeps);

    try {
      let result;
      switch (normalized.routeKey) {
        case "POST /enroll":
          result = await enrollHandler({ body: normalized.body }, enrollDeps);
          break;
        case "POST /checkin":
          result = await checkinHandler({ body: normalized.body }, checkinDeps);
          break;
        case "POST /claim":
          result = await claimHandler({ body: normalized.body }, { ...claimDeps, principalOf });
          break;
        case "GET /fleet":
          result = await fleetHandler({}, { ...fleetDeps, principalOf });
          break;
        case "POST /login":
          result = await loginHandler(
            { body: normalized.body, headers: normalized.headers, sourceIp: normalized.sourceIp },
            loginDeps,
          );
          break;
        case "POST /logout":
          result = await logoutHandler({ headers: normalized.headers }, loginDeps);
          break;
        default:
          log({ route: normalized.routeKey, reason: "not_found" });
          return respondJson(404, { ok: false, reason: "not_found" });
      }
      return toGatewayResponse(result);
    } catch (err) {
      // A handler that throws -> 500, logged as one line with the route and
      // the error message only (CLOUD-AWS-SPEC.md section B) — never the
      // event, body, headers or cookies, which carry passwords, cookies and
      // claim codes. This also catches an error the store throws while
      // principalOf resolves a session for /claim or /fleet: neither
      // handler catches its own `await deps.principalOf(event)`, so that
      // error propagates straight here rather than reading as a 401.
      log({ route: normalized.routeKey, message: messageOf(err) });
      return respondJson(500, { ok: false, reason: "internal" });
    }
  };
}

// ---- Lambda entry point ----
// Built ONCE per cold start, over the real DynamoDB store, and reused for
// every invocation that cold start serves.

/** @type {((event: Record<string, any>) => Promise<{statusCode: number, headers: Record<string,string>, body: string, cookies?: string[]}>) | null} */
let coldStartRoute = null;

/**
 * Build the production router: `createDynamoStore` (cloud/api/dynamoStore.mjs)
 * over the Lambda runtime's own AWS SDK, `TABLE_NAME` from the environment,
 * `Date.now` / `node:crypto`'s `randomBytes` / one JSON line via
 * `console.log`. Every AWS import is LAZY (inside this function, not at
 * module top level) so `createRouter` above works standalone — with no AWS
 * SDK and no cloud/api/dynamoStore.mjs on disk yet — exactly as
 * cloud/harness/lambdaRouter.harness.mjs needs it to.
 *
 * @returns {Promise<(event: Record<string, any>) => Promise<{statusCode: number, headers: Record<string,string>, body: string, cookies?: string[]}>>}
 */
async function buildProductionRoute() {
  const tableName = process.env.TABLE_NAME;
  if (typeof tableName !== "string" || tableName.length === 0) {
    throw new Error("cloud/lambda/router.mjs: the TABLE_NAME environment variable is required and was not set");
  }

  const [{ randomBytes }, { DynamoDBClient }, { DynamoDBDocumentClient }, { createDynamoStore }] = await Promise.all([
    import("node:crypto"),
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/lib-dynamodb"),
    import("../api/dynamoStore.mjs"),
  ]);

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = createDynamoStore({ tableName, doc });

  return createRouter({
    store,
    nowMs: Date.now,
    randomBytes,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}

/**
 * The actual Lambda handler: `cloud/lambda/router.handler` (CLOUD-AWS-SPEC.md
 * section C, `stack.yaml`'s function definition). Builds the production
 * router once per cold start and reuses it for every invocation after that.
 *
 * @param {Record<string, any>} event
 * @param {unknown} [context]
 * @returns {Promise<{statusCode: number, headers: Record<string,string>, body: string, cookies?: string[]}>}
 */
export async function handler(event, context) {
  if (coldStartRoute === null) {
    coldStartRoute = await buildProductionRoute();
  }
  return coldStartRoute(event);
}
