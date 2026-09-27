// agent/push-delivery.mjs
//
// Manager rules, build 2: phone alerts (MANAGER-ALERTS-SPEC.md "Delivery"
// and "The phone side"'s own Alerts-page routes). This file owns the ONE
// thing neither contracts/pushAlerts.ts (pure policy) nor agent/push-
// store.mjs (vapid.json and push-subscriptions.json) owns: turning a firing
// that wants an alert into an actual HTTP request, on a timer, and the HTTP
// routes a signed-in account uses to manage its own devices.
//
// What this file does NOT own: WHO may receive a firing (contracts/
// pushAlerts.ts's own mayReceiveFiring), the payload shape (buildPushPayload)
// or the retry schedule (decideDelivery/RETRY_SCHEDULE_MS) — all three are
// pure policy this file only ever CALLS; the VAPID identity and the wire
// protocol (agent/push-store.mjs, agent/web-push.mjs) — this file never reads
// a private key or touches node:crypto directly; and push-subscriptions.json
// itself — every read and write here goes through the store agent/push-
// store.mjs already hands out, including the account-scoping ("own only")
// that store already enforces at its own layer.
//
// THE FEARED FAILURE this file exists to prevent, twice over:
//  1. a subscription that has drifted out of standing (the account was
//     removed, or demoted to a role with neither rules.manage nor
//     events.view) still getting pushed to — mayReceiveFiring is called
//     fresh, from `standingOf`, on every single pass, never cached from an
//     earlier tick or from the moment the subscription was created;
//  2. a firing sent twice to the same phone — enforced three separate ways
//     that all have to hold at once: the UNIQUE(firing_id, subscription_id)
//     constraint in rules-db.mjs's own deliveries table (never a second
//     INSERT), the 'sending' claim written BEFORE the network call so a
//     crash between the push service answering and this process recording
//     that answer is resolved to 'failed' on the next pass rather than
//     guessed as "never happened" (rules-db.mjs's own resolveStaleSending,
//     see its schema comment), and never re-attempting a row already in a
//     terminal state (sent/failed/gone) regardless of how it got there.

import { mayReceiveFiring, buildPushPayload, decideDelivery, RETRY_SCHEDULE_MS } from '../dist/pushAlerts.js';
import { sendManagerAlertPush, loadOrCreatePublicVapidKey } from './push-store.mjs';
import { MAX_PLAINTEXT_BYTES, toBase64Url } from './web-push.mjs';
import { readJsonBody } from './camera-settings.mjs';

/** MANAGER-RULES-SPEC.md section 3's own evaluator ticks every 5 s; the
 *  sender ticks every 10 s (MANAGER-ALERTS-SPEC.md "Delivery": "A sender
 *  loop in api-server") — there is no reason for the two to share a period,
 *  and a slower one halves the read-firings-and-subscriptions cost on a box
 *  running both, for a firing that is going to be alerted within seconds
 *  either way. */
export const PUSH_SENDER_INTERVAL_MS = 10_000;

/** "Send a test alert", rate-limited to 1 per 30 s (MANAGER-ALERTS-SPEC.md
 *  "The Alerts page"). */
export const PUSH_TEST_RATE_LIMIT_MS = 30_000;

/** How long a push service should keep trying to deliver a notification to a
 *  phone that is briefly offline before giving up on its own (RFC 8030
 *  section 5.2's TTL header) — a day, generously past any shift, well short
 *  of making a very late alert about an already-closed store useful. */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * RFC 8292 section 2.1 requires a contact URI on every VAPID request; this
 * codebase names no real person or address anywhere (AGENTS.md: "No
 * credentials, camera URLs or person names anywhere"), and no site-level
 * contact field exists yet (an owner's own future addition, not this build's
 * to invent). CAMPLAT_VAPID_CONTACT lets a real deployment supply its own;
 * `.invalid` (RFC 2606) is the one TLD reserved for exactly this — a
 * placeholder that can never resolve to a real mailbox or site — so the
 * fallback is honest about being a fallback rather than a fabricated address.
 */
const DEFAULT_CONTACT = process.env.CAMPLAT_VAPID_CONTACT || 'mailto:noreply@camplat.invalid';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const refuse = (res, status, code, message, extra = {}) => sendJson(res, status, { ok: false, code, message, ...extra });

/** The push service's own origin, never the full endpoint — "an account sees
 *  ... only its own [subscriptions]" already keeps the endpoint itself off
 *  every response; this is the one fragment of it worth showing at all
 *  ("Get alerts on this phone" vs. "Get alerts on this desktop" reads as
 *  fcm.googleapis.com vs. apple push, which the host alone already says).
 *  Never throws: every stored endpoint already passed validateSubscription's
 *  own `new URL()` parse at write time, but a caller of this file's OWN
 *  exported view function is not obliged to prove that itself. */
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** One subscription as any route may show it back to its OWN account — never
 *  the endpoint or the keys (MANAGER-ALERTS-SPEC.md: "the endpoint shown
 *  only as its host"; the installer's own /push/counts never even gets
 *  this much, see subscriptionCountsByAccount in contracts/pushAlerts.ts). */
function subscriptionView(row) {
  return { id: row.id, label: row.label, rules: row.rules, createdUtc: row.createdUtc, endpointHost: endpointHost(row.endpoint) };
}

/** A subscription row's own PushSubscription JSON shape, exactly what agent/
 *  web-push.mjs's validateSubscription and encryptPayload expect — built
 *  fresh from the three stored fields every time rather than kept around
 *  from `add()`, so a stale reference can never drift from what is actually
 *  on disk. */
function rawSubscriptionOf(row) {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

/**
 * What to do after a send that never got an HTTP response at all — a DNS
 * failure, a dropped connection, a timeout (agent/web-push.mjs's own sendPush
 * throws for exactly this case, never returns a made-up status for it). The
 * brief for this build is explicit: "it retries on 429/5xx/network error per
 * the schedule" — the SAME schedule contracts/pushAlerts.ts's decideDelivery
 * already uses for 429/5xx, mirrored here rather than inventing a second one,
 * because a push service that is merely unreachable right now is exactly the
 * transient case retrying exists for, and RETRY_SCHEDULE_MS is exported for
 * precisely this kind of reuse.
 */
function decideAfterNetworkError(attempt) {
  if (attempt >= RETRY_SCHEDULE_MS.length) return { kind: 'failed' };
  return { kind: 'retry', delayMs: RETRY_SCHEDULE_MS[attempt], attempt: attempt + 1 };
}

/**
 * @param {object} args
 * @param {string} args.stateDir
 * @param {() => ({ firingsWantingAlert, deliveryRow, claimSending, recordOutcome, resolveStaleSending }) | null} args.getRulesDb
 *   rules.db, existence-gated the same way api-server.mjs's own openRules(false)
 *   already is — a site that has never had a rule fire has no file to open
 *   and nothing to send, never an error.
 * @param {{ all: () => Promise<{subscriptions: object[]}>, listOwn: (u: string) => Promise<{subscriptions: object[], problem: string|null}>,
 *           accountCounts: () => Promise<{counts: Record<string,number>, problem: string|null}>, add: Function, removeOwn: Function }} args.pushStore
 *   agent/push-store.mjs's createPushSubscriptionStore, already scoped to stateDir.
 * @param {(username: string) => { role: import('../dist/access.js').Role | null }} args.standingOf
 *   agent/auth.mjs's own read-only account lookup — re-checked fresh on every send.
 * @param {() => Promise<boolean>} args.isManagerRulesEnabled
 * @param {(event: string, req: object|null, fields?: object) => void} args.audit
 * @param {() => Date} [args.now]
 * @param {(...a: any[]) => void} [args.log]
 * @param {string} [args.contact]
 * @param {number} [args.ttlSeconds]
 * @param {typeof fetch} [args.fetchFn] - injected for the harness; sendManagerAlertPush
 *   falls back to the real global fetch when this is omitted, never a fake by default.
 * @param {number} [args.testRateLimitMs]
 */
export function createPushDelivery({
  stateDir,
  getRulesDb,
  pushStore,
  standingOf,
  isManagerRulesEnabled,
  audit,
  now = () => new Date(),
  log = () => {},
  contact = DEFAULT_CONTACT,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  fetchFn,
  testRateLimitMs = PUSH_TEST_RATE_LIMIT_MS,
}) {
  // username -> the ms clock reading of that account's last "Send a test
  // alert". In-process only: a restart forgets it, which is the same
  // conservative direction every other in-memory throttle in this codebase
  // (agent/auth.mjs's own login lockout) already takes for a limit whose
  // whole purpose is politeness, not security.
  const lastTestAtMs = new Map();

  /**
   * One pass: every firing wanting an alert, against every subscription that
   * may currently receive it. Never two passes overlapping (the same
   * single-flight guard agent/api-server.mjs's own runManagerRulesEvaluatorPass
   * and runEventRetentionPass already keep) — a slow push service must not
   * pile up a second pass's sends behind the first's.
   */
  let running = false;
  async function runSenderPass() {
    if (running) return;
    running = true;
    try {
      if (!(await isManagerRulesEnabled())) return;
      const rdb = getRulesDb();
      if (rdb === null) return; // no rule has ever fired on this box

      // Crash recovery FIRST, before this pass makes a single send of its
      // own — see rules-db.mjs's own schema comment on 'sending'.
      rdb.resolveStaleSending(now().getTime());

      const firings = rdb.firingsWantingAlert();
      if (firings.length === 0) return;
      const { subscriptions } = await pushStore.all();
      if (subscriptions.length === 0) return;

      // `subscriptions` is captured ONCE for this whole pass, but a
      // subscription decided 'gone' partway through it (a dead endpoint's
      // 404/410) is only removed from push-subscriptions.json, never from
      // this in-memory array -- without tracking that here, every firing
      // still pending for it after that point would try the network again
      // for an endpoint this SAME pass already proved dead.
      const goneThisPass = new Set();

      const nowMs = now().getTime();
      for (const firing of firings) {
        for (const sub of subscriptions) {
          if (goneThisPass.has(sub.id)) continue;
          // "It sends only firings created after the subscription existed,
          // so a new phone is not flooded with history" — checked against
          // the firing's own startMs (when the thing it is about actually
          // began), the same instant buildPushPayload's own `at` falls back
          // to for an incomplete firing.
          if (firing.startMs < Date.parse(sub.createdUtc)) continue;

          // Re-checked fresh on every pass, never cached (this file's own
          // header comment, feared failure 1).
          if (!mayReceiveFiring(standingOf(sub.username), sub.rules, firing.ruleId)) continue;

          const existing = rdb.deliveryRow(firing.id, sub.id);
          if (existing && (existing.state === 'sent' || existing.state === 'failed' || existing.state === 'gone')) continue;
          if (existing && existing.state === 'retry' && existing.nextAtMs !== null && existing.nextAtMs > nowMs) continue;

          const attempt = existing ? existing.attempts : 0;

          const built = buildPushPayload(firing, MAX_PLAINTEXT_BYTES);
          if (!built.ok) {
            // Refused whole, never truncated (contracts/pushAlerts.ts's own
            // doc on buildPushPayload) — and never retried either: the
            // firing's own text will not get shorter on the next pass.
            rdb.recordOutcome(firing.id, sub.id, { state: 'failed', attempts: attempt, nextAtMs: null, lastCode: null }, nowMs);
            log('error', 'push delivery: a firing\'s payload does not fit the plaintext budget', {
              firingId: firing.id, subscriptionId: sub.id, bytes: built.bytes, reason: built.reason,
            });
            continue;
          }

          // Claimed BEFORE the network call — this file's own header
          // comment, feared failure 2.
          rdb.claimSending(firing.id, sub.id, nowMs);

          let sendResult;
          try {
            // eslint-disable-next-line no-await-in-loop -- one push at a time, deliberately: see the header comment on running.
            sendResult = await sendManagerAlertPush(stateDir, {
              subscription: rawSubscriptionOf(sub),
              payload: JSON.stringify(built.payload),
              contact,
              ttlSeconds,
              now,
              ...(fetchFn ? { fetchFn } : {}),
            });
          } catch (err) {
            const decision = decideAfterNetworkError(attempt);
            if (decision.kind === 'retry') {
              rdb.recordOutcome(firing.id, sub.id, { state: 'retry', attempts: decision.attempt, nextAtMs: nowMs + decision.delayMs, lastCode: null }, nowMs);
            } else {
              rdb.recordOutcome(firing.id, sub.id, { state: 'failed', attempts: attempt, nextAtMs: null, lastCode: null }, nowMs);
            }
            log('error', 'push delivery: could not reach the push service', { firingId: firing.id, subscriptionId: sub.id, error: err.message });
            continue;
          }

          const decision = decideDelivery(sendResult.status, attempt);
          if (decision.kind === 'sent') {
            rdb.recordOutcome(firing.id, sub.id, { state: 'sent', attempts: attempt, nextAtMs: null, lastCode: sendResult.status }, nowMs);
          } else if (decision.kind === 'delete') {
            rdb.recordOutcome(firing.id, sub.id, { state: 'gone', attempts: attempt, nextAtMs: null, lastCode: sendResult.status }, nowMs);
            // Marked gone for the REST of this pass immediately — before the
            // removeOwn() below even resolves — so no other pending firing
            // for this same dead subscription gets a second real network
            // call in this pass (this file's own header comment, feared
            // failure 2's sibling: one dead endpoint, one call per pass).
            goneThisPass.add(sub.id);
            // The subscription's OWN username, read straight off the row this
            // pass already has — never a caller-supplied id, so this can
            // never delete anyone else's device (agent/push-store.mjs's own
            // removeOwn enforces the pairing anyway; this is belt only).
            // eslint-disable-next-line no-await-in-loop
            await pushStore.removeOwn({ username: sub.username, id: sub.id });
          } else if (decision.kind === 'retry') {
            rdb.recordOutcome(firing.id, sub.id, { state: 'retry', attempts: decision.attempt, nextAtMs: nowMs + decision.delayMs, lastCode: sendResult.status }, nowMs);
          } else {
            rdb.recordOutcome(firing.id, sub.id, { state: 'failed', attempts: attempt, nextAtMs: null, lastCode: sendResult.status }, nowMs);
          }
        }
      }
    } catch (err) {
      log('error', 'push delivery: unexpected error', { error: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  }

  /* ============================================================ HTTP routes */

  async function handle(req, res, pathname, method, principal) {
    // Every route below is gated by contracts/routeAccess.ts on events.view,
    // which no display or anonymous principal ever carries — principal.kind
    // is always 'user' by the time a request reaches this function.

    if (method === 'GET' && pathname === '/push/public-key') {
      const { publicKey, createdUtc } = await loadOrCreatePublicVapidKey(stateDir);
      sendJson(res, 200, { ok: true, publicKey: toBase64Url(publicKey), createdUtc });
      return true;
    }

    if (method === 'POST' && pathname === '/push/subscribe') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.subscription !== 'object' || body.subscription === null) {
        refuse(res, 400, 'bad_subscription', 'subscription is required');
        return true;
      }
      const result = await pushStore.add({
        username: principal.username,
        rawSubscription: body.subscription,
        label: typeof body.label === 'string' ? body.label : null,
        rules: body.rules ?? 'all',
      });
      if (!result.ok) {
        const status = result.code === 'invalid_subscription' || result.code === 'invalid_row' ? 400
          : result.code === 'subscriptions_unreadable' ? 409 : 500;
        refuse(res, status, result.code, result.message ?? 'this subscription could not be saved',
          result.errors ? { errors: result.errors } : {});
        return true;
      }
      // Never the endpoint or keys in the audit line (MANAGER-ALERTS-SPEC.md:
      // "Subscription endpoints and keys never appear in logs or audit").
      audit('push.subscribe', req, { actor: principal.username, id: result.subscription.id, label: result.subscription.label });
      sendJson(res, 200, { ok: true, subscription: subscriptionView(result.subscription) });
      return true;
    }

    if (method === 'POST' && pathname.startsWith('/push/unsubscribe/')) {
      const id = pathname.slice('/push/unsubscribe/'.length);
      if (id === '' || id.includes('/')) {
        refuse(res, 404, 'no_such_route', 'No such route');
        return true;
      }
      const result = await pushStore.removeOwn({ username: principal.username, id });
      if (!result.ok) {
        const status = result.code === 'not_found' ? 404 : result.code === 'subscriptions_unreadable' ? 409 : 500;
        refuse(res, status, result.code, result.message ?? 'no subscription with that id belongs to this account');
        return true;
      }
      audit('push.unsubscribe', req, { actor: principal.username, id });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === 'GET' && pathname === '/push/my-subscriptions') {
      const { subscriptions, problem } = await pushStore.listOwn(principal.username);
      sendJson(res, 200, { ok: true, subscriptions: subscriptions.map(subscriptionView), problem });
      return true;
    }

    if (method === 'POST' && pathname === '/push/test') {
      const nowMs = now().getTime();
      const last = lastTestAtMs.get(principal.username);
      if (last !== undefined && nowMs - last < testRateLimitMs) {
        const retryAfterS = Math.max(1, Math.ceil((testRateLimitMs - (nowMs - last)) / 1000));
        res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfterS) });
        res.end(JSON.stringify({ ok: false, code: 'rate_limited', message: `wait ${retryAfterS}s before sending another test alert` }));
        return true;
      }
      lastTestAtMs.set(principal.username, nowMs);

      const { subscriptions } = await pushStore.listOwn(principal.username);
      if (subscriptions.length === 0) {
        refuse(res, 404, 'no_devices', 'no devices are registered for alerts on this account yet');
        return true;
      }
      const payload = JSON.stringify({
        title: 'Test alert',
        body: 'If you can see this, alerts are working on this device.',
        url: '/',
        at: new Date(nowMs).toISOString(),
      });
      const results = [];
      for (const sub of subscriptions) {
        let sendResult;
        try {
          // eslint-disable-next-line no-await-in-loop -- a handful of the caller's OWN devices, never a hot path
          sendResult = await sendManagerAlertPush(stateDir, {
            subscription: rawSubscriptionOf(sub), payload, contact, ttlSeconds, now,
            ...(fetchFn ? { fetchFn } : {}),
          });
        } catch (err) {
          results.push({ id: sub.id, outcome: 'failed', message: err.message });
          continue;
        }
        if (sendResult.outcome === 'gone') {
          // eslint-disable-next-line no-await-in-loop
          await pushStore.removeOwn({ username: principal.username, id: sub.id });
        }
        results.push({ id: sub.id, outcome: sendResult.outcome });
      }
      sendJson(res, 200, { ok: true, results });
      return true;
    }

    if (method === 'GET' && pathname === '/push/counts') {
      const { counts, problem } = await pushStore.accountCounts();
      sendJson(res, 200, { ok: true, counts, problem });
      return true;
    }

    return false;
  }

  return { handle, runSenderPass };
}
