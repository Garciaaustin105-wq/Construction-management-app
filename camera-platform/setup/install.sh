#!/usr/bin/env bash
#
# Turn a bare Debian box into a camplat appliance.
#
# Safe to re-run. It does NOT format anything — disk preparation is printed as
# commands for you to run deliberately, because a script that formats disks is a
# script that one day formats the wrong one.
#
set -euo pipefail

STATE_DIR="${CAMPLAT_STATE_DIR:-/var/lib/camplat}"
STORE_ROOTS="${CAMPLAT_STORE_ROOTS:-/srv/camplat/disk0,/srv/camplat/disk1}"
APP_DIR="${CAMPLAT_APP_DIR:-/opt/camplat}"
RUN_USER="${CAMPLAT_USER:-camplat}"
TRUSTED_KEYS="${CAMPLAT_TRUSTED_KEYS:-/etc/camplat/trusted-keys.json}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
RELEASE="${1:-${CAMPLAT_RELEASE:-}}"
if [[ -n "$RELEASE" ]]; then
  [[ -f "$RELEASE" ]] || { echo "no release tarball at $RELEASE"; exit 1; }
  RELEASE="$(realpath "$RELEASE")"
elif [[ ! -f "$APP_DIR/VERSION" ]]; then
  echo "usage: install.sh camplat-<commit>.tar.gz   (build it on the dev machine: node setup/release.mjs)"
  exit 1
fi

# Cheap check before anything is installed: a box with no trust anchor refuses
# every upgrade (the safe failure), so an install that would leave it
# anchorless is a mistake worth catching in the first second. setup/trust-anchor.sh
# does the full work once node is available.
if [[ ! -f "$TRUSTED_KEYS" && -z "${CAMPLAT_TRUSTED_KEYS_SOURCE:-}" && "${CAMPLAT_BOOTSTRAP:-}" != "1" ]]; then
  echo "no trust anchor at $TRUSTED_KEYS, and no keys given" >&2
  echo "a recorder with no anchor installs nothing, rather than installing anything:" >&2
  echo "pass the public keys with CAMPLAT_TRUSTED_KEYS_SOURCE=<file>, or set" >&2
  echo "CAMPLAT_BOOTSTRAP=1 to install without one on purpose (upgrades stay" >&2
  echo "refused until an anchor is placed)." >&2
  exit 1
fi
if [[ "${CAMPLAT_BOOTSTRAP:-}" == "1" ]]; then
  warn "CAMPLAT_BOOTSTRAP=1: this install carries no trust anchor; every upgrade will be refused until one is placed"
fi

say "Packages"
apt-get update -qq
# ffmpeg does the muxing; smartmontools feeds drive health to the fleet console;
# nut handles the UPS; chrony because every timestamp in this system is only as
# good as the clock.
apt-get install -y --no-install-recommends \
  ffmpeg smartmontools nut-client chrony xfsprogs curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 24 ]]; then
  say "Node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
"$NODE_BIN" -v
node -e "require('node:sqlite')" >/dev/null 2>&1 || { echo "node at $NODE_BIN has no node:sqlite — the recorder index needs it"; exit 1; }

say "Trust anchor"
# The public keys an appliance installs releases against. They live OUTSIDE the
# program, so a forged release cannot bring its own; without them every
# upgrade is refused, so this is the step that makes the box upgradable.
# trust-anchor.sh places, keeps, or refuses, and says which.
CAMPLAT_APP_DIR="$APP_DIR" NODE_BIN="$NODE_BIN" \
  bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/trust-anchor.sh"

say "User and directories"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
# The render group is what lets ffmpeg use QuickSync for substream decode.
usermod -aG video,render "$RUN_USER" 2>/dev/null || true
install -d -o "$RUN_USER" -g "$RUN_USER" "$STATE_DIR"

say "Program"
if [[ -n "$RELEASE" ]]; then
  rm -rf "$APP_DIR.new"
  install -d -o root -g root -m 0755 "$APP_DIR.new"
  tar -xzf "$RELEASE" -C "$APP_DIR.new" --no-same-owner
  [[ -f "$APP_DIR.new/VERSION" && -f "$APP_DIR.new/agent/recorder-service.mjs" ]] || { echo "$RELEASE is not a camplat release"; rm -rf "$APP_DIR.new"; exit 1; }
  # Root owns the program and the service user can only read it: a recorder
  # that can rewrite its own code is one bug away from doing so.
  chown -R root:root "$APP_DIR.new"
  chmod -R u=rwX,go=rX "$APP_DIR.new"
  rm -rf "$APP_DIR.old"
  if [[ -d "$APP_DIR" ]]; then mv "$APP_DIR" "$APP_DIR.old"; fi
  mv "$APP_DIR.new" "$APP_DIR"
  echo "  installed $(cat "$APP_DIR/VERSION") into $APP_DIR (the previous release, if any, is at $APP_DIR.old)"
  echo "  a running recorder keeps the old code until: systemctl restart camplat-recorder camplat-api"
else
  echo "  no release given; keeping $(cat "$APP_DIR/VERSION")"
fi

say "Recording disks"
IFS=',' read -ra ROOTS <<< "$STORE_ROOTS"
for root in "${ROOTS[@]}"; do
  install -d -o "$RUN_USER" -g "$RUN_USER" "$root"
  if mountpoint -q "$root"; then
    fstype=$(findmnt -no FSTYPE "$root")
    opts=$(findmnt -no OPTIONS "$root")
    echo "  $root mounted ($fstype)"
    [[ "$fstype" == "xfs" ]] || warn "$root is $fstype, not xfs"
    [[ "$opts" == *allocsize* ]] || warn "$root lacks allocsize= — concurrent writers will fragment it"
  else
    warn "$root is NOT a mount point. It will fill the OS drive."
  fi
done

cat <<'DISKHELP'

  To prepare a fresh recording disk (DESTRUCTIVE — check the device name twice):

    lsblk -o NAME,SIZE,MODEL,SERIAL          # confirm which disk is which
    mkfs.xfs -f -L camplat0 /dev/sdX
    blkid /dev/sdX                           # take the UUID

  Then add to /etc/fstab, one line per disk:

    UUID=<uuid>  /srv/camplat/disk0  xfs  defaults,noatime,nodiratime,allocsize=64m,logbsize=256k,nofail,x-systemd.device-timeout=30s  0 2

  nofail keeps one dead disk from stopping the boot; the others keep recording.

  Mount it, then give it to the service user (mounting hides the empty
  directory this script made, and a fresh filesystem belongs to root):

    mount /srv/camplat/disk0
    chown camplat:camplat /srv/camplat/disk0

  allocsize=64m is the one that matters: without it eight concurrent writers
  fragment each segment across the platter, and playback seeks forever.

DISKHELP

say "systemd"
cat > /etc/systemd/system/camplat-recorder.service <<UNIT
[Unit]
Description=camplat recorder
After=network-online.target
Wants=network-online.target
ConditionPathExists=$STATE_DIR/config.json
# A recorder that cannot restart is a truck roll, so never give up.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=NODE_OPTIONS=--max-old-space-size=512
Environment=CAMPLAT_STATE_DIR=$STATE_DIR
ExecStart=$NODE_BIN $APP_DIR/agent/recorder-service.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/camplat-api.service <<UNIT
[Unit]
Description=camplat api (loopback only; reach it over an SSH tunnel)
After=camplat-recorder.service
ConditionPathExists=$STATE_DIR/config.json

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=CAMPLAT_STATE_DIR=$STATE_DIR
Environment=CAMPLAT_API_HOST=127.0.0.1
Environment=CAMPLAT_API_PORT=8080
ExecStart=$NODE_BIN $APP_DIR/agent/api-server.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/camplat-alerts.service <<UNIT
[Unit]
Description=camplat alerts check (reads health.json, writes alerts.json)
ConditionPathExists=$STATE_DIR/config.json

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=CAMPLAT_STATE_DIR=$STATE_DIR
ExecStart=$NODE_BIN $APP_DIR/agent/camctl.mjs alerts --restart-stale
UNIT
cat > /etc/systemd/system/camplat-alerts.timer <<UNIT
[Unit]
Description=camplat alerts check every 60 s

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
# Watchdog option A (HEALTH-ALERTS-DESIGN.md). The alerts check runs as
# $RUN_USER and cannot restart the recorder, so it writes a request file and
# this root path unit acts on it, once per request: the file is removed
# before the restart. Unproven until stage 2 on the box.
cat > /etc/systemd/system/camplat-recorder-restart.path <<UNIT
[Unit]
Description=camplat recorder restart request

[Path]
PathExists=$STATE_DIR/restart-recorder.request

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/camplat-recorder-restart.service <<UNIT
[Unit]
Description=camplat recorder restart (requested by the alerts check)

[Service]
Type=oneshot
ExecStart=/usr/bin/rm -f $STATE_DIR/restart-recorder.request
ExecStart=/usr/bin/systemctl restart --no-block camplat-recorder.service
UNIT
systemctl daemon-reload
systemctl enable camplat-recorder.service camplat-api.service camplat-alerts.timer camplat-recorder-restart.path
echo "  camplat-recorder, camplat-api and the alerts timer enabled; they start at boot once $STATE_DIR/config.json exists"

say "Logs"
# Uncapped, journald may take a tenth of the OS drive, which the index shares.
# Persistent, so the logs from before a power cut survive it: those are the
# ones you need.
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/camplat.conf <<'JOURNAL'
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=4G
MaxRetentionSec=1month
JOURNAL
systemctl restart systemd-journald
echo "  journald: persistent, capped at 1G, keeps 4G free on the OS drive"

say "Drive health"
# smartd watches every drive, runs a short self-test daily at 02:00 and a long
# one Saturdays at 03:00, and logs temperature changes. It only logs, to the
# journal: there is no mail on this box. No temperature thresholds: an NVMe OS
# drive runs hotter than a recording disk, and a limit right for one raises
# false alarms on the other. health.json reading it waits for real smartctl
# output from the box.
if [ -f /etc/smartd.conf ] && ! grep -q '# camplat: managed by setup/install.sh' /etc/smartd.conf && [ ! -f /etc/smartd.conf.camplat-orig ]; then
  cp -p /etc/smartd.conf /etc/smartd.conf.camplat-orig
fi
cat > /etc/smartd.conf <<'SMARTD'
# camplat: managed by setup/install.sh (the package's original is smartd.conf.camplat-orig)
DEVICESCAN -a -o on -S on -n standby,q -s (S/../.././02|L/../../6/03) -W 4
SMARTD
systemctl enable smartmontools.service >/dev/null 2>&1 || systemctl enable smartd.service >/dev/null 2>&1 || true
systemctl restart smartmontools.service 2>/dev/null || systemctl restart smartd.service 2>/dev/null || warn "smartd did not start: drive health is not being watched"
echo "  smartd: all drives, short test daily 02:00, long test Saturday 03:00, temperature changes of 4C logged"

say "Watchdog"
if [[ -c /dev/watchdog ]]; then
  sed -i 's/^#\?RuntimeWatchdogSec=.*/RuntimeWatchdogSec=30s/' /etc/systemd/system.conf
  echo "  hardware watchdog armed at 30s"
else
  warn "no /dev/watchdog — enable the iTCO watchdog in BIOS, else a hung box stays hung"
fi

say "Checks that need a human"
cat <<'MANUAL'
  BIOS, and the first one is the one people forget:

    [ ] Restore on AC Power Loss  ->  POWER ON
        Default is usually OFF. Without it a 3am outage leaves this box
        dead until somebody drives out.
    [ ] Watchdog timer (iTCO)     ->  ENABLED
    [ ] Deep C-states / suspend   ->  DISABLED

  Network:
    [ ] NIC 1 -> store LAN and internet
    [ ] NIC 2 -> camera segment only, no route to the internet

  Then:  node agent/camctl.mjs preflight
MANUAL
