# Handoff — signed updates, and what is next

Written 2026-09-17. Branch `claude/camera-service-plan-uwr6st`.
Read this before touching `setup/` or `contracts/releaseTrust.ts`.

**Protocol:** ask for EDITS, not whole files — a JSON array of `{id, find, replace}`
where each `find` matches exactly once. Whole-file rewrites have mangled UTF-8 in
this repo before. Windows checkouts are CRLF and models answer in LF, so normalise
to the file's convention before matching, or every multi-line edit misses for a
reason unrelated to the edit.

**Order for every change here:** contract in `contracts/`, then its harness in
`harness/`, then the code, then the UI. Add the suite to `harness/run-all.mjs`.
Verify with `node harness/run-all.mjs` and
`node ../../lowvoltage-app/node_modules/typescript/bin/tsc -p .` — both must be
clean. `camera-platform` has no `package.json`; do not run a bare `npx tsc`.

---

## What is already done

| Piece | State |
|---|---|
| `contracts/releaseTrust.ts` | Done. Pure decision: signature, manifest, tree match, build time. 14 checks. |
| `setup/release.mjs` | Writes `MANIFEST.json` (every file + sha256 + commit + `builtAtUtc`). Unsigned. |
| `setup/sign-release.mjs` | Signs the manifest bytes, Ed25519, key from `CAMPLAT_SIGNING_KEY` + `CAMPLAT_SIGNING_KEY_ID`. |
| `agent/verify-release.mjs` | Verifies and decides. Trust anchor `/etc/camplat/trusted-keys.json`, override `CAMPLAT_TRUSTED_KEYS`. |
| `setup/upgrade.sh` | Runs the **installed** verifier before swapping; refuses and deletes `$APP_DIR.new` on failure. |
| `setup/trust-anchor.sh` | Places the anchor from `CAMPLAT_TRUSTED_KEYS_SOURCE`; anchorless installs refused unless `CAMPLAT_BOOTSTRAP=1`; rotation needs `CAMPLAT_TRUSTED_KEYS_FORCE=1`. Called by install.sh; harness-tested. |
| `harness/releaseVerify.harness.mjs` | End-to-end with a throwaway generated key. 10 checks. |
| `harness/trustAnchor.harness.mjs` | The anchor script under bash, every path, cross-checked against `readTrustedKeys`. 8 checks. |

Two invariants that must not be weakened, both with checks on them:

1. **The trust anchor lives outside the release.** If `trusted-keys.json` ever
   ships inside the tarball, a forged release brings its own keys and verifies
   perfectly against itself. `releaseVerify` has a check that does exactly this.
2. **The verifier that runs is the installed one**, never the one inside the
   release being checked. Untrusted code must not decide whether to trust itself.
   Only a first install falls back to the new copy.

**No signing key exists in this repository and none should be created in it.**

---

## Next, in order

### 1. `setup/install.sh` must place the trust anchor — DONE 2026-09-17
Shipped as specified above, as `setup/trust-anchor.sh`, called by install.sh
(which gates on the anchor before apt runs, so an anchorless install is
refused in the first second, and calls the script once node is available).
`/etc/camplat/` is `root:root 0755`, the file `0644` root-owned, keys taken
from `CAMPLAT_TRUSTED_KEYS_SOURCE` only — a source inside `$APP_DIR`, its
`.new` or its `.old` is refused, so a release can never bring its own anchor.
Rotation is the add/deploy/remove dance, and the deploy step is
`CAMPLAT_TRUSTED_KEYS_FORCE=1`: a DIFFERENT anchor is never installed quietly.
`harness/trustAnchor.harness.mjs` runs the script under bash with the paths
redirected and holds its usable-key check against `readTrustedKeys`, so the
two cannot drift. What is still true from §2: none of it has run on a real box.

### 2. Bench the whole path on the laptop NVR — DONE 2026-09-17
Run against the ROG laptop NVR (Tailscale `100.104.228.7`), which ran the
pre-signing release `1c075c1a` — the honest first-install case, since that
release has no verifier of its own and `upgrade.sh` used the documented
fallback to the incoming release's verifier. Throwaway keypair generated
outside the repo; two releases built from the same tree ~30 s apart so a
replay of the older one is a real downgrade. Anchor placed from the signed
tarball's `trust-anchor.sh`; two signed upgrades landed (the restart also
revived a manually-stopped `camplat-api`); all five refusals — downgrade
replay, untrusted key, tampered file, extra file, unsigned old release —
refused with their plain-word reasons and left the box untouched. Full record
with verbatim outputs in `FIELD-NOTES.md` "Bench log — 2026-09-17". The keys
were throwaway bench keys, retired with the session.

### 3. Document it — DONE 2026-09-17
`DEPLOY-SIGN-IN.md` now signs the tarball in step 1 (with the key-location
sentence), places the anchor as a one-time step 4, and carries a "Signed
upgrades" section naming the two human overrides and the rotation dance.
`setup/README.md` §5 names the anchor requirement, `CAMPLAT_BOOTSTRAP=1`, and
fixes a stale "Node 22" (install.sh has installed Node 24 for a while).

### 4. `APPLIANCE-BOM.md` is wrong about decoding — DONE 2026-09-17
The "only decoding is the substream" claim corrected: decoding is the
substream plus the nine-tile wall on the NVR's own HDMI, both on QuickSync;
the site's other TVs are Mac Minis pulling tiles over the LAN, and serving
those is stream-copy, so it stays cheap. The N150 conclusion kept.

---

## Next, elsewhere — larger, and independent of the above

### 5. The BOM must become tiers, not two models
Bigger units are planned at 24+ cameras. The **software has no 16-camera cap** —
the only real 16s are `DESKTOP_TILES` in `bandwidth.ts`, `maxTotal` in
`liveNegotiation.ts`, and a comment in `detectSchedule.ts`. What moves per tier is
storage (16 cameras = 158 TB/yr, so 24 ≈ 237 TB and the 6-bay board may run out of
bays), the AI chip (Hailo-8 was sized at 16), and `GRID_SHAPES`, which stops at
4x4. Adding a 5x5 is now cheap: the layout icons draw themselves from the shape.

### 6. Measure one appliance under its real load — DONE 2026-09-18 (on the laptop)
`FIELD-NOTES.md` "Bench log — 2026-09-18". 16 cameras + 9-tile wall + 16
detector-style decodes: **recording PASSED, 100% of every window, no gaps.**
Drawing the wall is the dominant cost, more than recording all 16 cameras.
Run on a Ryzen laptop, so the pass/fail stands but no number is an N150 number:
rerun `bench/measure.sh` and `bench/integrity.mjs` on an N305 board (every box since 2026-09-19), wall first.
Five defects it surfaced are listed there; the IP-grouping one (a DVR-migrated
site shows one tile for sixteen cameras) and the kiosk bind are the urgent two.

### 7. D1 is blocked on clips, not on code
`AI-PLAN.md`: the answer key has machinery and no answers. Real footage with
hand-written expected events is needed before a detector can be scored. The
Review page's "Teach the AI" sheet is the tool for producing them; it needs the
bench camera.

---

## Decisions that are Austin's, not a model's

1. **Where the signing private key lives.** Hardware token or KMS, an offline
   machine, or a file on the build box. `sign-release.mjs` is deliberately the
   only file that touches it, so changing this rewrites one file and the
   appliance side does not change.
2. **Distinct cameras per site.** The whole BOM rests on 16.
3. **Tenancy for the cloud plane (B1):** one organisation with 180 sites, or many
   customers each with sites. This shapes every table and route and is expensive
   to change later. `BUILD-PLAN.md` B1 points at a "§2.5" that is not in this repo.

## Facts worth knowing before changing anything here

- Sites are **180+**, varied verticals (storage facilities among them), **every
  site has a manager** who watches in a browser on the site's own LAN. Remote
  viewing is for after-hours alerts and the occasional check, not the daily path.
- `contracts/uploadPolicy.ts` is written, tuned per `SiteKind`
  (`storage | carwash | generic`) and **never called by anything**. That is
  correct: it waits on the D1 detector. Do not "wire it up" as a fix.
- The bus has the long version: notes `camera-signed-updates`,
  `camera-site-topology`, `camera-tiers-and-licensing`, `camera-shipped-today`.
