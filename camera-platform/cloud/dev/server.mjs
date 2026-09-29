#!/usr/bin/env node
// cloud/dev/server.mjs — the whole local cloud, on the bench laptop, wired
// from the four real handlers (cloud/CLOUD-LOOP-SPEC.md section D): "prove
// the NVR and the cloud fit together, end to end ... with no AWS account
// resources and no network or firewall change."
//
// This file is GLUE, not a contract: every rule that actually decides
// anything (verifying an enrolment, checking a signed check-in, claiming a
// code, scoping a fleet listing) already lives in cloud/api/enroll.mjs,
// cloud/api/checkin.mjs, cloud/api/claim.mjs and cloud/api/fleet.mjs, and in
// the pure contracts underneath them. This file only: listens on loopback
// over https, decodes one HTTP request into the Lambda-style `event` each
// handler already expects, supplies the `deps` each handler's own doc
// comment names, and adds the ONE piece of dev-only glue the spec calls
// for -- placing a freshly claimed device on `site-dev` (CLOUD-LOOP-SPEC.md
// section D, "Seed and one piece of dev glue"), which stands in for a real
// assign-to-site endpoint that does not exist yet.
//
// NEVER LOGS a claim code, a bearer token or a private key -- see
// `logLine` below. `allowOpenEnrollment: true` is set ONLY here; every
// other caller of cloud/contracts/enroll.ts must refuse open enrolment
// (build rule 10: production enrolment needs the factory claim certificate,
// which does not exist yet).
//
// Run directly: `node cloud/dev/server.mjs --port 8443 --cert C --key K`
// (an IP-SAN 127.0.0.1 cert/key pair -- cloud/harness/devLoop.harness.mjs
// generates a throwaway one with openssl at runtime; nothing under this repo
// ever commits a real one, per this task's own hard rules).
//
// `startServer()` is exported so a harness can run this whole thing
// in-process, on a free (`port: 0`) port, and get back a `close()` that
// tears it down again -- see cloud/harness/devLoop.harness.mjs.

import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

import { handler as enrollHandler } from "../api/enroll.mjs";
import { handler as checkinHandler } from "../api/checkin.mjs";
import { handler as claimHandler } from "../api/claim.mjs";
import { handler as fleetHandler } from "../api/fleet.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";
import { loginHandler, logoutHandler, principalFromEvent } from "../api/login.mjs";

/** Loopback only -- CLOUD-LOOP-SPEC.md section D: "Listens on 127.0.0.1; any
 *  --host other than 127.0.0.1 or ::1 is refused at start." */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/** The dev tenancy's fixed ids (CLOUD-LOOP-SPEC.md section D, "Seed"). */
const DEV_INSTALLER_ID = "inst-dev";
const DEV_ORG_ID = "org-dev";
const DEV_SITE_ID = "site-dev";

/** The one fixed principal `/claim` and `/fleet` act as once the bearer token
 *  checks out (CLOUD-LOOP-SPEC.md section D, "Dev auth"). `installerId` is
 *  the extra field cloud/api/fleet.mjs's `ApiPrincipal` needs beyond the
 *  pure `Principal` (see that file's own "KNOWN SPEC/CONTRACT GAP" comment);
 *  cloud/api/claim.mjs only ever reads `role` and `scope.id`, both of which
 *  a plain `Principal` already carries. */
const DEV_PRINCIPAL = {
  userId: "installer_tech-dev",
  role: "installer_tech",
  scope: { kind: "installer", id: DEV_INSTALLER_ID },
  installerId: DEV_INSTALLER_ID,
};

/** How far a `sentAtUtc` may drift from this server's own clock before an
 *  enrolment is refused, in milliseconds -- the same 5-minute tolerance
 *  cloud/contracts/checkinVerify.ts already hard-codes as
 *  `CLOCK_SKEW_LIMIT_MS` for a check-in; CLOUD-LOOP-SPEC.md section D names
 *  no separate value for enrolment, and inventing a different number for the
 *  same kind of clock-skew tolerance would be a guess, not a decision (build
 *  rule 10). */
const ENROLL_MAX_SKEW_MS = 300000;

/** The largest a request body may be before this server refuses it outright,
 *  in bytes -- a generous ceiling meant only to stop an unbounded read from
 *  a misbehaving client on this loopback-only dev listener; every handler
 *  enforces its own tighter contract on top of this (cloud/api/checkin.mjs's
 *  own 64 KB `MAX_BODY_BYTES`, for instance). */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Real Ed25519 signature verification, via node:crypto -- the one function
 * every handler's `deps.verifySignature` is, whatever name its own JSDoc
 * gives its first argument (`message` for enroll, `digestHex` for checkin):
 * in both contracts that argument is always the plain canonical JSON text
 * to verify, not an actual hex digest, and Ed25519 signs that text directly
 * with no separate pre-hash step (contracts/deviceCheckin.ts's own top
 * comment). A `verifySignature` that itself throws is treated as `false`,
 * never propagated -- both `verifyEnrollment` and `verifyCheckin` already
 * assume that (their own contracts document it), but this function holds to
 * it independently too.
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

/** `deps.randomValues(n)` every handler that needs one asks for -- `n` fresh
 *  integers, each in `0..31`, via `crypto.randomInt(32)` (CLOUD-LOOP-SPEC.md
 *  section D: "randomValues via crypto.randomInt(32)"). Real randomness, not
 *  a harness's deterministic queue. */
function randomValues(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(randomInt(32));
  return out;
}

/**
 * One log line, exactly the shape every handler's own contract already
 * demands of it (`{ reason, deviceId }`, never a payload, a signature, a
 * public key, a claim code or the bearer token), tagged with which route
 * produced it. This is the WHOLE of this server's own request logging --
 * each handler calls `deps.log` exactly once per request already; this
 * function only prints what it is handed, verbatim, plus a `route` label.
 *
 * @param {string} route
 * @param {{reason: string|null, deviceId: string|null}} entry
 */
function logLine(route, entry) {
  console.log(JSON.stringify({ route, reason: entry?.reason ?? null, deviceId: entry?.deviceId ?? null }));
}

/**
 * The one log line for `/login` and `/logout` -- `loginHandler` already
 * calls `deps.log` with its own `{ route, reason, userId }` shape
 * (cloud/CLOUD-LOGIN-SPEC.md section C step 5: never a login name, a
 * password, a token, or its hash); this only prints what it is handed,
 * verbatim, the same promise `logLine` above keeps for every other route.
 * `logoutHandler` never calls `deps.log` at all (it has nothing worth
 * logging beyond what the HTTP status already says).
 *
 * @param {{route?: string, reason: string|null, userId?: string|null}} entry
 */
function authLogLine(entry) {
  console.log(JSON.stringify({ route: entry?.route ?? "login", reason: entry?.reason ?? null, userId: entry?.userId ?? null }));
}

/**
 * The one in-memory store every handler shares, plus the dev-only glue
 * CLOUD-LOOP-SPEC.md section D calls for: "After a successful claim, the dev
 * server places the device on site-dev in that tenancy (and sets the store
 * record's siteId). This stands in for the future assign-to-site endpoint;
 * it is marked dev-only in the code."
 *
 * cloud/api/memoryStore.mjs's own top comment settles that `Store` itself
 * has no method to load or mutate a tenancy after construction -- only a
 * seed argument read once, at construction, and `getTenancy` to read it back
 * (`"NOT a general-purpose write method on Store itself, and NOT reachable
 * from any HTTP handler"`). A device claimed after this server started needs
 * to appear in `inst-dev`'s tenancy anyway, so this function keeps that ONE
 * tenancy as its own mutable object, outside the store, and overrides only
 * `getTenancy("inst-dev")` to hand back a fresh snapshot of it -- every other
 * `Store` method (and every other installerId's `getTenancy`, though this
 * dev server only ever seeds the one) passes straight through to a real
 * `createMemoryStore()`. This is dev-only glue, not a second store
 * implementation: it is never asked to satisfy
 * cloud/harness/storeConformance.harness.mjs, and nothing outside this file
 * ever calls `placeDeviceOnDevSite`.
 */
function createDevStore() {
  const base = createMemoryStore();

  /** @type {import("../api/store.mjs").Tenancy} */
  const devTenancy = {
    installers: [{ id: DEV_INSTALLER_ID, name: "Dev Installer" }],
    orgs: [
      {
        id: DEV_ORG_ID,
        installerId: DEV_INSTALLER_ID,
        name: "Dev Org",
        privacy: { offered: false, installerBlocked: false },
      },
    ],
    groups: [],
    sites: [{ id: DEV_SITE_ID, orgId: DEV_ORG_ID, groupId: null, name: "Dev Site" }],
    // Dev-only glue: mutated by placeDeviceOnDevSite() after each successful
    // /claim, never read or written anywhere else.
    devices: [],
  };

  /** Dev-only glue, called ONLY from the /claim route below, ONLY after
   *  claimHandler itself has already returned a 200. Idempotent: claiming
   *  (or re-claiming after a revoke) the same device twice never duplicates
   *  its entry in the tenancy tree. */
  function placeDeviceOnDevSite(deviceId) {
    if (!devTenancy.devices.some((d) => d.deviceId === deviceId)) {
      devTenancy.devices.push({ deviceId, siteId: DEV_SITE_ID });
    }
  }

  const store = {
    ...base,
    async getTenancy(installerId) {
      if (installerId === DEV_INSTALLER_ID) {
        return structuredClone(devTenancy);
      }
      return base.getTenancy(installerId);
    },
  };

  return { store, placeDeviceOnDevSite };
}

/** Reads a whole request body as UTF-8 text, refusing (never buffering
 *  without bound) past `MAX_REQUEST_BODY_BYTES`. Every handler this server
 *  calls does its own, tighter size and shape checking on top of this; this
 *  is only the outer safety net a loopback-only dev listener still owes any
 *  client that sends it garbage. */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        // Stop buffering but keep the socket: destroying it here left the
        // caller nothing to answer on, so clients saw a reset instead of a
        // 413 (review finding, 2026-09-27). The rest is drained unread and
        // the caller closes the connection once the 413 has gone out.
        chunks.length = 0;
        req.off("data", onData);
        req.resume();
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Writes a handler's own Lambda-style `{ statusCode, headers, body }`
 *  result straight to the real HTTP response -- verbatim, since every
 *  handler already builds a `body` that is JSON text and a `headers` object
 *  with the one content-type header it needs. */
function sendHandlerResult(res, result) {
  res.writeHead(result.statusCode, result.headers);
  res.end(result.body);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(body);
}

/**
 * The dev bearer principal this request carries, or `null` -- CLOUD-LOOP-SPEC.md
 * section D: "`/claim` and `/fleet` need `Authorization: Bearer <token>` and
 * then act as one fixed principal ... No token -> 401 no_principal." Compared
 * with `timingSafeEqual` (both sides padded to the same length first, so a
 * length mismatch never itself throws) rather than `===`, since this is the
 * one check standing between a caller and every device this dev server
 * knows about.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} token
 * @returns {typeof DEV_PRINCIPAL | null}
 */
function principalFor(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  if (provided.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(provided, expected)) return null;
  } catch {
    return null;
  }
  return DEV_PRINCIPAL;
}

/**
 * Start the local cloud dev server. Loopback only: `host` other than
 * `127.0.0.1` or `::1` REJECTS before anything is bound (CLOUD-LOOP-SPEC.md
 * section D). `cert` and `key` are paths to a PEM certificate and private
 * key (an IP-SAN 127.0.0.1 throwaway pair, generated at runtime -- see
 * cloud/harness/devLoop.harness.mjs -- never a real one committed to this
 * public repo).
 *
 * Resolves once the server is actually listening, with:
 * - `url`: `https://<host>/` reachable base (IPv6 bracketed), with the real
 *   bound port (so `port: 0`, "any free port", still gives back one you can
 *   connect to).
 * - `token`: the random dev bearer token this instance just generated --
 *   NEVER logged by this file itself (the CLI's own `main()` below is the
 *   one place it is ever printed, once, at startup).
 * - `close()`: async; shuts the listener down and resolves once every
 *   connection is gone -- a harness can call this between runs without a
 *   lingering socket keeping the process alive.
 * - `store`: the SAME `Store` (cloud/api/store.mjs) every route handler
 *   above shares, so a harness can run cloud/admin/admin.mjs's `runAdmin`
 *   directly against it (CLOUD-LOGIN-SPEC.md, "F. Tests that matter", the
 *   devLoop bullet: "seed an installer and a user through runAdmin") without
 *   this server exposing any HTTP route that itself creates installers or
 *   users -- the setup tool and the dev server end up looking at one and the
 *   same in-memory store, exactly as a real installer's browser and a real
 *   `runAdmin` run against production DynamoDB would.
 *
 * @param {{port?: number, host?: string, cert: string, key: string}} opts
 * @returns {Promise<{url: string, token: string, store: import("../api/store.mjs").Store, close: () => Promise<void>}>}
 */
export async function startServer({ port = 0, host = "127.0.0.1", cert, key } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `startServer: refusing to listen on ${JSON.stringify(host)} -- only 127.0.0.1 or ::1 (loopback) is allowed`,
    );
  }
  if (typeof cert !== "string" || cert.length === 0) {
    throw new Error("startServer: cert (a path to a PEM certificate) is required");
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("startServer: key (a path to a PEM private key) is required");
  }

  const [certPem, keyPem] = await Promise.all([readFile(cert, "utf8"), readFile(key, "utf8")]);

  // The dev bearer token: printed once by the CLI below, NEVER by this
  // function, and never logged by any route handler in this file.
  const token = randomBytes(24).toString("hex");

  const { store, placeDeviceOnDevSite } = createDevStore();
  const nowMs = () => Date.now();

  const enrollDeps = {
    store,
    nowMs,
    verifySignature,
    randomValues,
    allowOpenEnrollment: true, // ONLY here -- CLOUD-LOOP-SPEC.md section D.
    maxSkewMs: ENROLL_MAX_SKEW_MS,
    log: (entry) => logLine("enroll", entry),
  };
  const checkinDeps = {
    store,
    nowMs,
    verifySignature,
    principalOf: () => null, // a check-in authenticates by signature, never a principal.
    log: (entry) => logLine("checkin", entry),
  };
  // claimDeps and fleetDeps have no `principalOf` of their own here: each
  // route below builds one per request, as `() => principalFor(req, token)`
  // closing over that request's own `req` (never the Lambda-style `event`
  // this dev server hands the handler, which carries no headers at all) --
  // see the /claim and /fleet routes.
  const claimDeps = {
    store,
    nowMs,
    verifySignature, // present for a uniform deps shape; claim.mjs never calls it.
    log: (entry) => logLine("claim", entry),
  };
  const fleetDeps = {
    store,
    nowMs,
    verifySignature, // present for a uniform deps shape; fleet.mjs never calls it.
    log: (entry) => logLine("fleet", entry),
  };
  // deps for /login, /logout and principalFromEvent (CLOUD-LOGIN-SPEC.md
  // section C): deps.scryptParams is left undefined so this dev server
  // hashes and verifies at the SAME cost production would -- a dev server
  // standing in for the real thing should not cut a corner an installer's
  // real login never gets.
  const loginDeps = {
    store,
    nowMs,
    randomBytes,
    log: authLogLine,
  };

  const server = createHttpsServer({ cert: certPem, key: keyPem }, async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "https://placeholder").pathname;
    } catch {
      sendJson(res, 400, { ok: false, reason: "bad_request" });
      return;
    }

    try {
      if (req.method === "POST" && pathname === "/enroll") {
        const body = await readRequestBody(req);
        const result = await enrollHandler({ body }, enrollDeps);
        sendHandlerResult(res, result);
        return;
      }

      if (req.method === "POST" && pathname === "/checkin") {
        const body = await readRequestBody(req);
        const result = await checkinHandler({ body }, checkinDeps);
        sendHandlerResult(res, result);
        return;
      }

      if (req.method === "POST" && pathname === "/login") {
        const body = await readRequestBody(req);
        const result = await loginHandler(
          { body, headers: req.headers, sourceIp: req.socket.remoteAddress },
          loginDeps,
        );
        sendHandlerResult(res, result);
        return;
      }

      if (req.method === "POST" && pathname === "/logout") {
        const result = await logoutHandler({ headers: req.headers }, loginDeps);
        sendHandlerResult(res, result);
        return;
      }

      if (req.method === "POST" && pathname === "/claim") {
        const body = await readRequestBody(req);
        // /claim accepts EITHER the dev bearer token OR a real installer
        // session (CLOUD-LOGIN-SPEC.md section F) -- the dev token is tried
        // first so every already-scripted dev workflow keeps working
        // unchanged; `viaDevToken` is kept so the dev-only site placement
        // glue below fires only for a dev-token claim.
        const devPrincipal = principalFor(req, token);
        const viaDevToken = devPrincipal !== null;
        const principal = viaDevToken
          ? devPrincipal
          : await principalFromEvent({ headers: req.headers }, loginDeps);
        const result = await claimHandler({ body }, { ...claimDeps, principalOf: () => principal });
        if (result.statusCode === 200 && viaDevToken) {
          // Dev-only glue (CLOUD-LOOP-SPEC.md section D), kept ONLY for a
          // dev-token claim: place the freshly claimed device on site-dev,
          // in both the store record and the dev tenancy tree, so /fleet
          // (which cross-references both, cloud/api/fleet.mjs step 4) can
          // find it. A real installer session's claimed device is placed
          // with the setup tool's own assign-device command instead
          // (CLOUD-LOGIN-SPEC.md section E/F) -- this dev server no longer
          // guesses a site for it.
          let claimedDeviceId = null;
          try {
            claimedDeviceId = JSON.parse(result.body)?.deviceId ?? null;
          } catch {
            claimedDeviceId = null;
          }
          if (typeof claimedDeviceId === "string" && claimedDeviceId.length > 0) {
            const device = await store.getDevice(claimedDeviceId);
            if (device !== null && device.siteId !== DEV_SITE_ID) {
              await store.putDevice({ ...device, siteId: DEV_SITE_ID }, { ifState: device.state });
            }
            placeDeviceOnDevSite(claimedDeviceId);
          }
        }
        sendHandlerResult(res, result);
        return;
      }

      if (req.method === "GET" && pathname === "/fleet") {
        // Same dual-auth as /claim above: the dev bearer token first, then a
        // real installer session.
        const devPrincipal = principalFor(req, token);
        const principal =
          devPrincipal !== null ? devPrincipal : await principalFromEvent({ headers: req.headers }, loginDeps);
        const result = await fleetHandler({}, { ...fleetDeps, principalOf: () => principal });
        sendHandlerResult(res, result);
        return;
      }

      logLine("unknown", { reason: "not_found", deviceId: null });
      sendJson(res, 404, { ok: false, reason: "not_found" });
    } catch (err) {
      if (err && err.code === "BODY_TOO_LARGE" && !res.headersSent) {
        logLine("oversized", { reason: "payload_too_large", deviceId: null });
        res.setHeader("connection", "close");
        res.on("finish", () => req.destroy());
        sendJson(res, 413, { ok: false, reason: "payload_too_large" });
        return;
      }
      // Refuse rather than crash the whole dev server over one bad request
      // (build rule 10) -- but never hand the client anything more than a
      // generic reason; the real detail goes to this process's own stderr,
      // never to the wire.
      console.error(`cloud/dev/server.mjs: unhandled error on ${req.method} ${pathname}:`, err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, reason: "internal_error" });
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(undefined);
    });
  });

  const boundPort = server.address().port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `https://${urlHost}:${boundPort}`;

  async function close() {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }

  return { url, token, store, close };
}

// ---- CLI entry point ----
// `node cloud/dev/server.mjs --port P --cert C --key K [--host H]`.

function parseArgs(argv) {
  const args = { port: undefined, host: "127.0.0.1", cert: undefined, key: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (flag === "--port") args.port = Number(value);
    else if (flag === "--host") args.host = value;
    else if (flag === "--cert") args.cert = value;
    else if (flag === "--key") args.key = value;
    else throw new Error(`unrecognised argument: ${flag}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 0 || !args.cert || !args.key) {
    console.error(
      "usage: node cloud/dev/server.mjs --port <port> --cert <path> --key <path> [--host 127.0.0.1|::1]",
    );
    process.exitCode = 1;
    return;
  }

  const { url, token, close } = await startServer(args);
  console.log(`cloud/dev/server.mjs listening at ${url}`);
  console.log(`dev bearer token: ${token}`);
  console.log("(this token, and everything this dev server holds, disappears when the process exits)");

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\ncloud/dev/server.mjs: ${signal} received, shutting down`);
    close().then(
      () => process.exit(0),
      (err) => {
        console.error("cloud/dev/server.mjs: error while shutting down:", err);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
