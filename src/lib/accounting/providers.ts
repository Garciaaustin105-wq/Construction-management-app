// Side-effect-only barrel that imports + registers every accounting adapter so
// the provider registry is populated wherever `getProvider` is called. Routes
// and connections.ts import this module (or a module that imports it) to ensure
// registration runs before the first `getProvider` lookup. Add a new provider
// here when you ship its adapter.
//
// SQL/RLS/auth/security stay Claude-direct; adapters themselves are mechanical
// HTTP (local-AI candidates) — see [[lowvoltage-local-model-delegation]].

import "./quickbooks";
import "./xero";
import "./freshbooks";
// import "./wave";        // deferred — GraphQL product-ID dance; build on user demand
// import "./stripe_byo";  // deferred — paste-key flow (Stripe classic OAuth deprecated)