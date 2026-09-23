#!/usr/bin/env bash
# Swap in a new camplat release on a box that is already installed.
#
#   sudo setup/upgrade.sh /tmp/camplat-<sha>.tar.gz
#
# install.sh does this too, but it also re-runs the disk, service and journald
# setup, with defaults (store roots, service user) that may not be what this
# box was installed with. An upgrade should touch the program and nothing else:
# no disks, no units, no state. The previous release stays at /opt/camplat.old,
# so going back is `mv` and a restart.
#
# First upgrade to a release with sign-in: nobody can use the web UI until an
# installer account exists. Open /login through the SSH tunnel and create it.
# Over the tunnel the request arrives from loopback, so no activation code is
# asked for -- whoever holds SSH to the box already has more than the code
# would give. From anywhere else the code is in $STATE_DIR/activation-code.
set -euo pipefail

APP_DIR="${CAMPLAT_APP_DIR:-/opt/camplat}"
STATE_DIR="${CAMPLAT_STATE_DIR:-/var/lib/camplat}"
RELEASE="${1:-}"

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
[[ -n "$RELEASE" && -f "$RELEASE" ]] || { echo "usage: sudo $0 <camplat-release.tar.gz>"; exit 1; }
[[ -d "$APP_DIR" ]] || { echo "$APP_DIR does not exist: this box was never installed; use setup/install.sh"; exit 1; }

rm -rf "$APP_DIR.new"
install -d -o root -g root -m 0755 "$APP_DIR.new"
tar -xzf "$RELEASE" -C "$APP_DIR.new" --no-same-owner
if [[ ! -f "$APP_DIR.new/VERSION" || ! -f "$APP_DIR.new/agent/recorder-service.mjs" || ! -f "$APP_DIR.new/agent/api-server.mjs" ]]; then
  echo "$RELEASE is not a camplat release"
  rm -rf "$APP_DIR.new"
  exit 1
fi
# Root owns the program; the service user can only read it.
chown -R root:root "$APP_DIR.new"
chmod -R u=rwX,go=rX "$APP_DIR.new"

# A release is installed only once it can be shown to be genuine: signed by a
# key this box trusts, every file matching the manifest, and not older than what
# is installed. The trust anchor is /etc/camplat/trusted-keys.json, OUTSIDE the
# release, so a forged tarball cannot bring its own keys along.
#
# The verifier that runs is the INSTALLED one, never the one inside the release
# being checked -- code that has not been trusted yet must not be the thing
# deciding whether to trust it. Only a first install falls back to the new copy,
# and then there is nothing on the box to protect.
VERIFIER="$APP_DIR/agent/verify-release.mjs"
[[ -f "$VERIFIER" ]] || VERIFIER="$APP_DIR.new/agent/verify-release.mjs"
VERIFY_FLAGS=()
[[ "${CAMPLAT_ALLOW_DOWNGRADE:-}" == "1" ]] && VERIFY_FLAGS+=(--allow-downgrade)
[[ "${CAMPLAT_ALLOW_DIRTY:-}" == "1" ]] && VERIFY_FLAGS+=(--allow-dirty)
if ! node "$VERIFIER" "$APP_DIR.new" --installed "$APP_DIR" "${VERIFY_FLAGS[@]}"; then
  echo "refusing to install $RELEASE: it could not be shown to be genuine"
  rm -rf "$APP_DIR.new"
  exit 1
fi

echo "current: $(cat "$APP_DIR/VERSION" 2>/dev/null || echo unknown)"
echo "new:     $(cat "$APP_DIR.new/VERSION")"

rm -rf "$APP_DIR.old"
mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"

# A changed unit file is not picked up by a plain restart -- systemd keeps
# running against the copy it already loaded until something reloads it.
# Found today: a unit file install.sh had rewritten was not applied on an
# upgrade's restart for exactly this reason. Cheap and always safe to run
# even when no unit changed, so it runs on every upgrade, not just when one is
# known to have.
systemctl daemon-reload
systemctl restart camplat-recorder camplat-api
sleep 3
systemctl --no-pager --lines=0 status camplat-recorder camplat-api | grep -E "^\S|Active:" || true

if [[ ! -f "$STATE_DIR/accounts.json" ]]; then
  echo
  echo "No accounts yet. Through the tunnel, open http://127.0.0.1:<local port>/login and create the installer account."
fi
echo
echo "Roll back:  sudo mv $APP_DIR $APP_DIR.bad && sudo mv $APP_DIR.old $APP_DIR && sudo systemctl restart camplat-recorder camplat-api"
