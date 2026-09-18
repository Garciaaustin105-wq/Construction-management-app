#!/usr/bin/env bash
# Place the trust anchor: the public keys an appliance installs releases
# against, at /etc/camplat/trusted-keys.json -- OUTSIDE every release, so a
# forged tarball cannot bring its own keys along and verify against itself.
#
# Run by setup/install.sh (which installs node first and passes NODE_BIN), and
# safe to re-run: an anchor that already exists is never replaced without
# CAMPLAT_TRUSTED_KEYS_FORCE=1.
#
#   CAMPLAT_TRUSTED_KEYS_SOURCE=<file>  where the public keys come from; a
#                                       path a person passes, never anything
#                                       inside the release being installed
#   CAMPLAT_TRUSTED_KEYS=<file>         where the anchor lives (default
#                                       /etc/camplat/trusted-keys.json; the
#                                       verifier reads the same variable)
#   CAMPLAT_BOOTSTRAP=1                 install with no anchor, on purpose
#   CAMPLAT_TRUSTED_KEYS_FORCE=1        replace a DIFFERENT anchor, on purpose
#                                       (rotation: add the new id, deploy with
#                                       FORCE, then remove the old id)
#   CAMPLAT_APP_DIR=<dir>               the installed program (default
#                                       /opt/camplat); a source inside it, or
#                                       its .new/.old siblings, is refused
#   NODE_BIN=<node>                     node to validate the keys file with
#
# This script does not require root -- the harness runs it unprivileged with
# the paths redirected -- but in the field it only ever runs under install.sh,
# which already checked. Root ownership and 0644 are applied when it is root.
set -euo pipefail

KEYS_FILE="${CAMPLAT_TRUSTED_KEYS:-/etc/camplat/trusted-keys.json}"
SOURCE="${CAMPLAT_TRUSTED_KEYS_SOURCE:-}"
APP_DIR="${CAMPLAT_APP_DIR:-/opt/camplat}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }

[[ -n "$NODE_BIN" ]] || { echo "trust-anchor.sh needs node to check the keys file, and there is none on PATH" >&2; exit 1; }

# The key ids the verifier (agent/verify-release.mjs, readTrustedKeys) would
# trust in this file: same shape rules, revoked skipped, duplicates folded.
# The two must not drift, and harness/trustAnchor.harness.mjs holds them
# against each other: what this accepts, the verifier must trust.
usable_ids() {
  CAMPLAT_KEYS_TO_CHECK="$1" "$NODE_BIN" -e '
    const { readFileSync } = require("node:fs");
    let ids = [];
    try {
      const body = JSON.parse(readFileSync(process.env.CAMPLAT_KEYS_TO_CHECK, "utf8"));
      if (typeof body === "object" && body !== null && Array.isArray(body.keys)) {
        const seen = {};
        for (const k of body.keys) {
          if (typeof k !== "object" || k === null) continue;
          if (typeof k.id !== "string" || typeof k.publicKeyPem !== "string") continue;
          if (k.revoked === true) continue;
          seen[k.id] = true;
        }
        ids = Object.keys(seen).sort();
      }
    } catch {}
    console.log(ids.join(" "));
  '
}

# install(1) with root ownership, but only as root: a non-root run is the
# harness or a curious operator, and chown would fail there for no reason.
install_dir() {
  if [[ $EUID -eq 0 ]]; then install -d -o root -g root -m 0755 "$1";
  else install -d -m 0755 "$1"; fi
}
install_file() { # install_file <source> <dest>
  if [[ $EUID -eq 0 ]]; then install -o root -g root -m 0644 "$1" "$2";
  else install -m 0644 "$1" "$2"; fi
}

KEYS_DIR="$(dirname "$KEYS_FILE")"

if [[ -n "$SOURCE" ]]; then
  [[ -f "$SOURCE" ]] || { echo "CAMPLAT_TRUSTED_KEYS_SOURCE: no file at $SOURCE" >&2; exit 1; }

  # THE INVARIANT: the anchor never ships with the code it vouches for. A keys
  # file inside the installed program (or the release half-unpacked beside it)
  # would make a forged release self-verifying and the signature meaningless.
  SRC_REAL="$(realpath -m "$SOURCE")"
  for d in "$APP_DIR" "$APP_DIR.new" "$APP_DIR.old"; do
    D_REAL="$(realpath -m "$d")"
    if [[ "$SRC_REAL" == "$D_REAL" || "$SRC_REAL" == "$D_REAL"/* ]]; then
      echo "refused: $SOURCE is inside $d" >&2
      echo "an anchor that ships with a release vouches for nothing: pass a file from outside the release" >&2
      exit 1
    fi
  done

  read -ra IDS <<< "$(usable_ids "$SOURCE")"
  if [[ ${#IDS[@]} -eq 0 ]]; then
    echo "refused: $SOURCE holds no usable key" >&2
    echo "a file with no usable key refuses every upgrade, exactly like no anchor at all -- pretending otherwise helps nobody" >&2
    exit 1
  fi

  if [[ -f "$KEYS_FILE" ]]; then
    if cmp -s "$SOURCE" "$KEYS_FILE"; then
      echo "  anchor unchanged: ${#IDS[@]} key(s) trusted here: ${IDS[*]}"
      exit 0
    fi
    if [[ "${CAMPLAT_TRUSTED_KEYS_FORCE:-}" != "1" ]]; then
      echo "refused: $KEYS_FILE already holds a DIFFERENT anchor" >&2
      echo "replacing a trust anchor is rotation, and rotation is deliberate:" >&2
      echo "  add the new key id to the file, deploy it with CAMPLAT_TRUSTED_KEYS_FORCE=1, then remove the old id" >&2
      exit 1
    fi
    warn "replacing the anchor at $KEYS_FILE (CAMPLAT_TRUSTED_KEYS_FORCE=1)"
  fi

  install_dir "$KEYS_DIR"
  install_file "$SOURCE" "$KEYS_FILE"
  echo "  anchor placed: ${#IDS[@]} key(s) trusted here: ${IDS[*]}"
  exit 0
fi

# No source given: keep whatever anchor is there, and never remove one.
if [[ -f "$KEYS_FILE" ]]; then
  read -ra IDS <<< "$(usable_ids "$KEYS_FILE")"
  if [[ ${#IDS[@]} -eq 0 ]]; then
    warn "$KEYS_FILE exists but holds NO usable key -- this box refuses every upgrade until that is fixed"
  else
    echo "  anchor kept: ${#IDS[@]} key(s) trusted here: ${IDS[*]}"
  fi
  if [[ $EUID -eq 0 ]]; then chown root:root "$KEYS_FILE"; chmod 0644 "$KEYS_FILE"; fi
  exit 0
fi

if [[ "${CAMPLAT_BOOTSTRAP:-}" == "1" ]]; then
  warn "CAMPLAT_BOOTSTRAP=1: installing with NO trust anchor"
  warn "this box will refuse every upgrade until one is placed:"
  warn "  re-run install.sh with CAMPLAT_TRUSTED_KEYS_SOURCE=<file>"
  exit 0
fi

echo "refused: no trust anchor at $KEYS_FILE, and CAMPLAT_TRUSTED_KEYS_SOURCE is not set" >&2
echo "a recorder with no anchor installs nothing, rather than installing anything" >&2
echo "bring the public keys (CAMPLAT_TRUSTED_KEYS_SOURCE=<file>), or set CAMPLAT_BOOTSTRAP=1 to install without one on purpose" >&2
exit 1