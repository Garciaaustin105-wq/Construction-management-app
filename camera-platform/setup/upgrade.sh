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

echo "current: $(cat "$APP_DIR/VERSION" 2>/dev/null || echo unknown)"
echo "new:     $(cat "$APP_DIR.new/VERSION")"

rm -rf "$APP_DIR.old"
mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"

systemctl restart camplat-recorder camplat-api
sleep 3
systemctl --no-pager --lines=0 status camplat-recorder camplat-api | grep -E "^\S|Active:" || true

if [[ ! -f "$STATE_DIR/accounts.json" ]]; then
  echo
  echo "No accounts yet. Through the tunnel, open http://127.0.0.1:<local port>/login and create the installer account."
fi
echo
echo "Roll back:  sudo mv $APP_DIR $APP_DIR.bad && sudo mv $APP_DIR.old $APP_DIR && sudo systemctl restart camplat-recorder camplat-api"
