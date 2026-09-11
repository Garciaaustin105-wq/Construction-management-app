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

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

say "Packages"
apt-get update -qq
# ffmpeg does the muxing; smartmontools feeds drive health to the fleet console;
# nut handles the UPS; chrony because every timestamp in this system is only as
# good as the clock.
apt-get install -y --no-install-recommends \
  ffmpeg smartmontools nut-client chrony xfsprogs curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  say "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "User and directories"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
# The render group is what lets ffmpeg use QuickSync for substream decode.
usermod -aG video,render "$RUN_USER" 2>/dev/null || true
install -d -o "$RUN_USER" -g "$RUN_USER" "$STATE_DIR" "$APP_DIR"

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

    UUID=<uuid>  /srv/camplat/disk0  xfs  defaults,noatime,nodiratime,allocsize=64m,logbsize=256k  0 2

  allocsize=64m is the one that matters: without it eight concurrent writers
  fragment each segment across the platter, and playback seeks forever.

DISKHELP

say "systemd"
cat > /etc/systemd/system/camplat-recorder.service <<UNIT
[Unit]
Description=camplat recorder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=NODE_OPTIONS=--max-old-space-size=512
Environment=CAMPLAT_STATE_DIR=$STATE_DIR
Environment=CAMPLAT_STORE_ROOTS=$STORE_ROOTS
ExecStart=/usr/bin/node $APP_DIR/agent/recorder-service.mjs
Restart=always
RestartSec=5
# A recorder that cannot restart is a truck roll, so never give up.
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "  camplat-recorder.service written (not started — no config yet)"

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
