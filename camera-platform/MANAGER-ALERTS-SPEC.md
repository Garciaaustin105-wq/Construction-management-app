# Manager rules, build 2: phone alerts (Web Push)

This builds on MANAGER-RULES-SPEC.md (build 1: firings with `alertWanted`
in rules.db).

Owner's decisions:
- Alerts are opt-in, for staff only (memory alerts-are-customer-opt-in).
- Austin wants no alerts himself: his installer account is never
  subscribed automatically.
- There is NO license gating. Whether a lapsed license stops alerts is
  undecided (memory features-are-per-site-options).

## The pieces

**VAPID identity.** A P-256 key pair is generated once on the box with
agent/web-push.mjs `generateVapidKeys`.
- It is stored in `<stateDir>/vapid.json`, mode 0600, owned by the service
  user (the same ownership lesson as the device identity: chown when root
  creates it).
- The public key is served to the browser.
- The private key never leaves the file, and never appears in any
  response or log.

**Subscriptions.**
- They are stored in `<stateDir>/push-subscriptions.json` (0600): one row
  per account per device.
- Each row holds `{ id, username, endpoint, p256dh, auth, createdUtc,
  label ("iPhone Safari"), rules: "all" | [ruleId...] }`.
- Every subscription is checked with `validateSubscription`.
- An account sees and removes only its own. The installer can see a count
  per account, but never the endpoints.
- Subscribe and remove are audited.

**Delivery.** A sender loop in api-server:
1. It reads firings with `alertWanted` that were not yet sent.
2. For each subscription whose account may see that rule (`rules.manage`
   or `events.view`) and whose selection includes the rule, it calls
   `sendPush`. The payload is title, body (the firing's identity-free
   wording), `url` (`/reports?day=...`, or the Review deep link) and `at`,
   staying under `MAX_PLAINTEXT_BYTES`.
3. It records each attempt: sent / failed with code / gone.

Failure handling:
- HTTP 404 or 410 means the subscription is gone and is deleted.
- 429 or 5xx is retried with backoff (1 min, 5 min, 30 min), then given
  up and recorded as failed.
- A firing is never sent twice to the same subscription.
- Rule cooldowns (build 1) already limit repeats.
- The loop is unref()'d, has a close hook, and is idle when the
  managerRules switch is off.

**No picture in the notification** in this build. The notification opens
the page, which shows the still behind the sign-in. A picture would need an
unauthenticated image URL, which this NVR never serves.

## The phone side

- **The Alerts page** (`alerts.html` + `alerts-client.mjs`) is for managers
  and installers.
  - "Get alerts on this phone" registers a service worker and subscribes
    with the box's VAPID public key.
  - Choose all my rules, or pick rules.
  - "Send a test alert".
  - A list of my devices, each with Remove.
- **A service worker** (`/sw.js`, served at root scope with the right
  headers) shows the notification and opens `url` when tapped.
- **Secure context.** The Push API only works on a secure page: HTTPS, or
  localhost. When the page is not secure it says so plainly and hides the
  button. That applies over plain http on the LAN.
  - Tailscale HTTPS certificates (Austin's pending step) or the future
    cloud relay make it secure.
  - iPhone: web push works only after "Add to Home Screen" (iOS 16.4+).
    The page detects iOS Safari and shows that one step.

## Tests that matter

- vapid.json is created once, is 0600, and its private key never appears
  in any JSON, log or page.
- A subscription for another account is never listed, removed or sent to.
- 404/410 deletes the subscription.
- 429/5xx retries with backoff, then records failed.
- A firing is never double-sent.
- managerRules off means no sends.
- An account opted in to specific rules gets only those rules.
- An installer never receives an alert without subscribing themselves.
- A payload over the size limit is refused, never truncated
  mid-character.
- The insecure-page message.
- The bootstrap check for the new client.
- The service worker's click opens the `url`.
