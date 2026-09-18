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
| `harness/releaseVerify.harness.mjs` | End-to-end with a throwaway generated key. 10 checks. |

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

### 1. `setup/install.sh` must place the trust anchor
It currently never writes `/etc/camplat/trusted-keys.json`. Without it a box has
no anchor and `verify-release.mjs` refuses everything, which is the safe failure
but makes upgrades impossible.

- Create `/etc/camplat/` as `root:root 0755` and the file `0644`, root-owned.
- Take the public keys from a path the installer passes
  (`CAMPLAT_TRUSTED_KEYS_SOURCE`), never from inside the release.
- Refuse to install with no anchor unless `CAMPLAT_BOOTSTRAP=1` is set, and say so.
- File shape: `{"keys":[{"id":"...","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n..."}]}`.
  A key with `"revoked": true` is ignored — `readTrustedKeys` already does this.

### 2. Bench the whole path on the laptop NVR
Not done, and nothing here has run against a real box.
Generate a throwaway keypair, place the anchor, build, sign, upgrade. Then prove
the refusals on real hardware: tamper one file, add an unlisted file, sign with
an untrusted key, replay an older release. Record what happened in `FIELD-NOTES.md`.

### 3. Document it
`DEPLOY-SIGN-IN.md` and `setup/README.md` still describe an unsigned upgrade.
They should state where the anchor lives, how to rotate a key (add the new id,
deploy, then remove the old), and that `CAMPLAT_ALLOW_DOWNGRADE=1` and
`CAMPLAT_ALLOW_DIRTY=1` exist and are deliberate human overrides.

---

## Next, elsewhere — larger, and independent of the above

### 4. `APPLIANCE-BOM.md` is wrong about decoding
Line 127 says *"The only decoding is the substream for detection."* That is false
once a TV is attached: sites run 9 tiles on the NVR's own HDMI output, with other
TVs driven by Mac Minis pulling over the LAN. Correct the claim and keep the
conclusion honest — serving the other tiles is stream-copy and stays cheap.

### 5. The BOM must become tiers, not two models
Bigger units are planned at 24+ cameras. The **software has no 16-camera cap** —
the only real 16s are `DESKTOP_TILES` in `bandwidth.ts`, `maxTotal` in
`liveNegotiation.ts`, and a comment in `detectSchedule.ts`. What moves per tier is
storage (16 cameras = 158 TB/yr, so 24 ≈ 237 TB and the 6-bay board may run out of
bays), the AI chip (Hailo-8 was sized at 16), and `GRID_SHAPES`, which stops at
4x4. Adding a 5x5 is now cheap: the layout icons draw themselves from the shape.

### 6. Measure one appliance under its real load
Never measured. Put the HDMI wall, a manager's browser and the detector on one box
at once and record CPU, iGPU, disk read, and **whether recording drops a frame** —
that last one is the only pass/fail. Numbers go in `FIELD-NOTES.md` beside the
measured bitrate, not into a doc as an assumption.

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
