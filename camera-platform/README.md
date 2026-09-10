# camera-platform

Contracts for the internal camera platform. **Pure modules only** — no I/O, no
React, no browser globals, no Node globals. They compile standalone and every
one has a harness that runs in about a second without a camera, a network or a
database.

This is step one of the house build order: *contract in a pure lib, then a
harness, then the UI* (`docs/build-rules.md` A1). Nothing here talks to a camera
yet. The appliance and the console are built on top of these, not beside them.

## Layout

```
contracts/     pure TypeScript, compiled standalone by tsconfig.json
  time.ts      UTC instants and range validation
  segment.ts   the recording index — where each span of time lives, and gaps
  retention.ts how many days fit on a disk, or a refusal
  camera.ts    camera identity (MAC + serial, never IP) and discovery records
  rtsp.ts      per-vendor RTSP URL templating and credential redaction
harness/       standalone runners, plain node, no test framework
dist/          emitted; gitignored
```

## Running

```bash
cd camera-platform
npx tsc -p tsconfig.json     # compiles standalone — `"types": []` proves purity
node harness/run-all.mjs     # 48 checks
```

`tsconfig.json` sets `"types": []` deliberately: if a contract ever reaches for
`process` or `Buffer`, the build breaks. That is the point. The root
`tsconfig.json` excludes this directory, because it is NodeNext while the Next.js
app is bundler resolution.

## The four rules these encode

Each of these is a bug that looks fine on screen, which is why it is a type and
a test rather than a convention.

**A gap is a value, not an absence.** `Segment.tier` includes `"gap"`, carrying a
`gapReason`. During a break-in investigation, *"the camera was offline"* and
*"nothing happened"* are opposite answers; a timeline that renders both as empty
space has told the viewer the wrong one. `buildTimeline` always returns a
contiguous span covering the whole query window.

**A blank is not a zero.** `bytes` is `null` on a gap, never `0`, so an outage
cannot sum as free footage. `bitrateKbps` is `null` when unmeasured, and
`computeRetentionDays` **refuses** rather than substituting a default — a camera
really pushing 4 Mbps where 2 was assumed halves a store's retention and looks
completely normal.

**Identity is MAC + serial, never IP.** DHCP moves, cameras reboot onto new
addresses, subnets get renumbered. `reconcile` returns a known camera at a new
address as `known` with `ipChanged` so the record updates *silently* — that
happens constantly and must never raise an alert. Conflicting serials return
`ambiguous` rather than being forced to a yes or no.

**Refuse rather than guess.** An unknown camera vendor returns
`{ kind: "unsupported" }` with a message, not a plausible RTSP path that fails at
3am. Every refusal names what was missing.

## Conventions

Credentials never reach a log: `buildRtspUrl` returns both `url` (playable) and
`redacted` (safe to print). Callers log the second and pass the first only to the
media stack.

Every quantity carries its unit in its name — `bitrateKbps`, `bytes`,
`recordedSeconds`, `EpochMs`.
