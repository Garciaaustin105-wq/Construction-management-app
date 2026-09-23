#!/usr/bin/env bash
#
# Stop any local login from reading a camera password off a running process's
# command line. Measured on the bench (2026-09-23): a normal, non-root admin
# login could read the recorder's ffmpeg command line, which contains
# rtsp://user:password@... -- /proc is world-readable by default, and a
# command line is not a secret file, it is a directory listing.
#
# The accepted Linux fix: mount /proc with hidepid=invisible, so a login only
# sees its OWN processes in /proc, plus a "gid=" group whose members keep
# seeing everyone -- system helpers that must enumerate every process still
# need to (polkitd, on Ubuntu 24.04 / systemd 255, is the one this script
# knows about). Root always sees everything regardless of hidepid.
#
#   sudo setup/harden-proc.sh                 apply, remount now
#   sudo setup/harden-proc.sh --dry-run       print the plan, change nothing
#   sudo setup/harden-proc.sh --undo          restore hidepid=off
#
# --fstab PATH and --no-remount exist so a harness can run the real fstab
# logic against a throwaway file on a dev machine (harness/hardenProc.harness.mjs)
# without root and without touching a real /proc: naming a NON-default fstab
# path is treated as that kind of scoped test run, and root is not required
# for it (build rule 21 -- a harness never touches real data unscoped). The
# real /etc/fstab, and the actual remount, always require root.
#
# What this script will NEVER do: add the admin login or the camplat service
# user to the group. Only the one named system helper goes in it.
set -euo pipefail

DEFAULT_FSTAB="/etc/fstab"
GROUP="${CAMPLAT_PROC_GROUP:-proc}"
# The only account this script ever adds to the group. Not configurable on
# purpose -- widening this list is a deliberate, reviewed change, not a flag.
REQUIRED_USER="polkitd"
BASE_OPTS="rw,nosuid,nodev,noexec,relatime"

DRY_RUN=0
FSTAB="$DEFAULT_FSTAB"
NO_REMOUNT=0
UNDO=0

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }
refuse() { echo "refused: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage: harden-proc.sh [--dry-run] [--fstab PATH] [--no-remount] [--undo]

  --dry-run      print the planned changes; touch nothing
  --fstab PATH   fstab file to read/edit (default /etc/fstab). A path other
                 than the default is a scoped test run and does not need root.
  --no-remount   edit fstab (and back it up) but do not remount /proc now
  --undo         restore hidepid=off (fstab line + remount), and say what it did

Env: CAMPLAT_PROC_GROUP overrides the group name (default: proc).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --fstab) [[ $# -ge 2 ]] || refuse "--fstab needs a path"; FSTAB="$2"; shift 2 ;;
    --fstab=*) FSTAB="${1#--fstab=}"; shift ;;
    --no-remount) NO_REMOUNT=1; shift ;;
    --undo) UNDO=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) refuse "unknown argument: $1 (see --help)" ;;
  esac
done

# A path other than the real default is a caller deliberately scoping this
# run to a throwaway file -- that is the harness's doorway in, and it does not
# need root because nothing about the real system is touched.
REAL_DEFAULT="$(realpath -m "$DEFAULT_FSTAB")"
REQUESTED="$(realpath -m "$FSTAB")"
LIVE=0
[[ "$REQUESTED" == "$REAL_DEFAULT" ]] && LIVE=1

if [[ "$DRY_RUN" -ne 1 && "$LIVE" -eq 1 && "$EUID" -ne 0 ]]; then
  refuse "must run as root to modify $DEFAULT_FSTAB and remount /proc (sudo setup/harden-proc.sh; or --dry-run to preview; or --fstab PATH to test against a scoped copy)"
fi

# Options this script understands on an existing /proc line. Anything else and
# it refuses rather than guess what a stranger's line means (build rule 10) --
# rewriting a line with an option nobody here recognises could silently drop
# something that mattered.
is_known_opt() {
  case "$1" in
    rw|ro|nosuid|suid|nodev|dev|noexec|exec|relatime|atime|noatime|nodiratime|diratime|defaults|sync|async|nofail|auto|noauto|user|nouser|subset=*) return 0 ;;
    *) return 1 ;;
  esac
}

# Find the /proc line, if one exists: first non-comment, non-blank line whose
# mountpoint (field 2) is /proc. Historically most Debian/Ubuntu boxes have NO
# such line at all -- the kernel mounts /proc on its own -- so "none found" is
# the common case, not an error.
PROC_LINE_NUM=""
if [[ -f "$FSTAB" ]]; then
  PROC_LINE_NUM="$(awk 'NF>=4 && $1 !~ /^#/ && $2=="/proc" {print NR; exit}' "$FSTAB")"
fi

OLD_OPTS=""
DEV="proc"; MNT="/proc"; FSTYPE="proc"; DUMP="0"; PASS="0"
if [[ -n "$PROC_LINE_NUM" ]]; then
  read -r DEV MNT FSTYPE OLD_OPTS DUMP PASS _ < <(awk -v n="$PROC_LINE_NUM" 'NR==n{ if (NF<5) $5="0"; if (NF<6) $6="0"; print $1, $2, $3, $4, $5, $6 }' "$FSTAB")
fi

existing_opts=()
[[ -n "$OLD_OPTS" ]] && IFS=',' read -ra existing_opts <<< "$OLD_OPTS"

unknown=()
kept=()
cur_hidepid=""
cur_gid=""
for o in "${existing_opts[@]+"${existing_opts[@]}"}"; do
  case "$o" in
    hidepid=*) cur_hidepid="${o#hidepid=}" ;;
    gid=*) cur_gid="${o#gid=}" ;;
    *)
      if is_known_opt "$o"; then kept+=("$o"); else unknown+=("$o"); fi
      ;;
  esac
done

if [[ ${#unknown[@]} -gt 0 ]]; then
  refuse "the /proc line in $FSTAB has option(s) this script does not recognise: ${unknown[*]} -- fix or remove them by hand first, nothing was changed (line: proc line #$PROC_LINE_NUM)"
fi

if [[ -z "$PROC_LINE_NUM" ]]; then
  IFS=',' read -ra kept <<< "$BASE_OPTS"
fi

if [[ "$UNDO" -eq 1 ]]; then
  if [[ -z "$PROC_LINE_NUM" ]]; then
    echo "no /proc line in $FSTAB -- nothing to undo"
    exit 0
  fi
  if [[ "$cur_hidepid" == "off" || -z "$cur_hidepid" ]]; then
    echo "hidepid is already off (or unset) on $FSTAB -- nothing to undo"
    exit 0
  fi
  new_kept=("${kept[@]+"${kept[@]}"}")
  # Drops hidepid and ANY gid= on the line, whoever set it: with hidepid=off a
  # gid= lets nobody through that could not already see everything, so it has
  # no effect left to preserve. The group itself is left in place.
  new_opts_arr=("${new_kept[@]}" "hidepid=off")
else
  if [[ "$cur_hidepid" == "invisible" && "$cur_gid" == "$GROUP" ]]; then
    echo "already configured: $FSTAB's /proc line has hidepid=invisible,gid=$GROUP"
    if [[ "$DRY_RUN" -ne 1 ]]; then exit 0; fi
    echo "(dry run: nothing else to do)"
    exit 0
  fi
  new_opts_arr=("${kept[@]+"${kept[@]}"}" "hidepid=invisible" "gid=$GROUP")
fi

NEW_OPTS="$(IFS=,; echo "${new_opts_arr[*]}")"
NEW_LINE="$DEV $MNT $FSTYPE $NEW_OPTS $DUMP $PASS"

if [[ "$DRY_RUN" -eq 1 ]]; then
  say "Plan (--dry-run: nothing below is applied)"
  if [[ "$UNDO" -ne 1 ]]; then
    echo "  first, group '$GROUP' would be created if missing (system group, no login shell)"
    echo "  and user '$REQUIRED_USER' added to '$GROUP' if not already a member"
    echo "  (never the admin login, never camplat)"
  fi
  if [[ -n "$PROC_LINE_NUM" ]]; then
    echo "  fstab line #$PROC_LINE_NUM would change from:"
    echo "    proc line: $DEV $MNT $FSTYPE $OLD_OPTS $DUMP $PASS"
  else
    echo "  no existing /proc line in $FSTAB; one would be appended:"
  fi
  echo "  to:"
  echo "    $NEW_LINE"
  echo "  a timestamped backup of $FSTAB would be made first"
  if [[ "$LIVE" -eq 1 && "$NO_REMOUNT" -ne 1 ]]; then
    echo "  /proc would be remounted now with: $NEW_OPTS"
  else
    echo "  /proc would NOT be remounted now (--no-remount, or a scoped --fstab)"
  fi
  exit 0
fi

# The group and the one helper user that must still see every process -- set
# up BEFORE fstab or the live mount names the group. mount turns gid=proc into
# a number by looking the group up, so a remount naming a group that does not
# exist yet fails, and so would the fstab line at the next boot. Real system
# state, so this only ever runs as actual root -- a scoped test run (non-root,
# non-default --fstab) proves the fstab logic below and skips this.
if [[ "$UNDO" -ne 1 ]]; then
  if [[ "$EUID" -eq 0 ]]; then
    if getent group "$GROUP" >/dev/null 2>&1; then
      echo "  group '$GROUP' already exists"
    else
      groupadd --system "$GROUP"
      echo "  group '$GROUP' created (system group)"
    fi
    if getent passwd "$REQUIRED_USER" >/dev/null 2>&1; then
      MEMBERS="$(getent group "$GROUP" | cut -d: -f4)"
      if [[ ",$MEMBERS," == *",$REQUIRED_USER,"* ]]; then
        echo "  '$REQUIRED_USER' is already in '$GROUP'"
      else
        usermod -aG "$GROUP" "$REQUIRED_USER"
        echo "  '$REQUIRED_USER' added to '$GROUP'"
      fi
    else
      warn "no '$REQUIRED_USER' account on this box -- polkit will not be able to see other users' processes until it (or the real polkit daemon user here) is added to '$GROUP' by hand"
    fi
  else
    echo "  skipping group/user setup: not root (this is a scoped --fstab test run)"
  fi
fi

# Back up before touching anything real. If this fails, stop -- an unbacked-up
# fstab edit is the one mistake here with no undo.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="${FSTAB}.camplat-bak.${TS}.$$"
if [[ ! -f "$FSTAB" ]] || ! cp -p "$FSTAB" "$BACKUP"; then
  refuse "could not back up $FSTAB to $BACKUP -- nothing was changed"
fi

# Rewrite line-by-line so every OTHER line stays byte-for-byte identical; only
# the one /proc line is replaced, or a new one appended.
mapfile -t LINES < "$FSTAB"
TMP="$(mktemp)"
if [[ -n "$PROC_LINE_NUM" ]]; then
  for i in "${!LINES[@]}"; do
    if [[ $((i+1)) -eq "$PROC_LINE_NUM" ]]; then
      printf '%s\n' "$NEW_LINE"
    else
      printf '%s\n' "${LINES[$i]}"
    fi
  done > "$TMP"
else
  { printf '%s\n' "${LINES[@]+"${LINES[@]}"}"; printf '%s\n' "$NEW_LINE"; } > "$TMP"
fi
chmod --reference="$FSTAB" "$TMP" 2>/dev/null || chmod 0644 "$TMP"
mv "$TMP" "$FSTAB"
echo "  $FSTAB updated (backup: $BACKUP)"
echo "  proc line: $NEW_LINE"

if [[ "$LIVE" -eq 1 && "$NO_REMOUNT" -ne 1 ]]; then
  if mount -o "remount,${NEW_OPTS}" /proc 2>/dev/null; then
    echo "  /proc remounted: $NEW_OPTS"
  else
    warn "remount failed -- the fstab entry is set and will take effect on next boot, or remount by hand: mount -o remount,${NEW_OPTS} /proc"
  fi
else
  echo "  /proc not remounted (--no-remount, or a scoped --fstab); takes effect on next boot or a manual remount"
fi

say "Done"
if [[ "$UNDO" -eq 1 ]]; then
  echo "  hidepid restored to off"
else
  echo "  hidepid=invisible, gid=$GROUP -- only root and '$GROUP' members see every process now"
fi
