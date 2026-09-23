#!/usr/bin/env bash
#
# Read-only. Checks that setup/harden-proc.sh actually did its job on THIS
# box, without ever putting a camera password on the screen.
#
#   run as the admin login (NOT root):  bash setup/verify-hidepid.sh
#
# Deliberately never lists every field of every process, never asks a
# process what it was started with, and never reads what a process had set
# for its own runtime variables. Every check below is a count, a boolean, or
# a timestamp -- nothing here can print a credential, because nothing here
# ever asks a process to show what it was launched with.
#
# Exit 0 only when every check below passes. Non-zero otherwise, with each
# result named in plain words so a non-root login can paste the output
# without pasting anything sensitive.
set -uo pipefail

APP_DIR="${CAMPLAT_APP_DIR:-/opt/camplat}"
STATE_DIR="${CAMPLAT_STATE_DIR:-/var/lib/camplat}"
GROUP="${CAMPLAT_PROC_GROUP:-proc}"
FRESH_MS="${CAMPLAT_VERIFY_FRESH_MS:-120000}"

CHECKS=0
FAILS=0

record() { # record <ok|fail> <name> <detail...>
  local status="$1" name="$2"; shift 2
  CHECKS=$((CHECKS + 1))
  if [[ "$status" == ok ]]; then
    printf '  ok    %-28s %s\n' "$name" "$*"
  else
    FAILS=$((FAILS + 1))
    printf '  FAIL  %-28s %s\n' "$name" "$*"
  fi
}

# judge_proc_opts <mount options> <the group's numeric gid, or "" if missing>
# Prints "ok", or why not. The kernel reports the group as a NUMBER (gid=997),
# never the name harden-proc.sh wrote into fstab, and options are compared
# whole -- a substring test would let gid=12 pass for gid=123. hidepid=2 is
# how kernels before 5.8 print hidepid=invisible.
judge_proc_opts() {
  local opts="$1" gid="$2" o hide=0 gid_ok=0
  local -a list=()
  if [[ -z "$opts" ]]; then echo "could not read /proc's mount options at all"; return; fi
  IFS=',' read -ra list <<< "$opts"
  for o in "${list[@]}"; do
    [[ "$o" == "hidepid=invisible" || "$o" == "hidepid=2" ]] && hide=1
    [[ -n "$gid" && "$o" == "gid=$gid" ]] && gid_ok=1
  done
  if [[ "$hide" -ne 1 ]]; then
    echo "hidepid=invisible not active — currently: $opts"
  elif [[ -z "$gid" ]]; then
    echo "hidepid is active, but there is no '$GROUP' group on this box, so nothing is let through (polkit included) — currently: $opts"
  elif [[ "$gid_ok" -ne 1 ]]; then
    echo "hidepid is active, but not with gid=$gid ('$GROUP') — currently: $opts"
  else
    echo ok
  fi
}

# Sourced (by the harness, to test the judgment above): define, touch nothing.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi

echo "camplat verify-hidepid — read-only, counts only, no command lines"
echo

if [[ "$EUID" -eq 0 ]]; then
  echo "note: running as root — the process-visibility check below only means"
  echo "      something when it is run as the ordinary admin login instead."
  echo
fi

# 1. What /proc is actually mounted with right now.
PROC_OPTS=""
if command -v findmnt >/dev/null 2>&1; then
  PROC_OPTS="$(findmnt -no OPTIONS /proc 2>/dev/null || true)"
fi
if [[ -z "$PROC_OPTS" ]]; then
  PROC_OPTS="$(awk '$1=="proc" && $2=="/proc" {print $4; exit}' /proc/mounts 2>/dev/null || true)"
fi
GID_NUM=""
if command -v getent >/dev/null 2>&1; then
  GID_NUM="$(getent group "$GROUP" 2>/dev/null | cut -d: -f3 || true)"
fi
VERDICT="$(judge_proc_opts "$PROC_OPTS" "$GID_NUM")"
if [[ "$VERDICT" == ok ]]; then
  record ok "proc mount options" "$PROC_OPTS"
else
  record fail "proc mount options" "$VERDICT"
fi

# 2. How many camplat-owned processes THIS login can see. After hardening,
# with a non-root, non-camplat login, that should be zero. pgrep -c prints
# only a count, never a command line.
if command -v pgrep >/dev/null 2>&1; then
  OWN_COUNT="$(pgrep -c -u camplat 2>/dev/null || true)"
  OWN_COUNT="${OWN_COUNT:-0}"
  if [[ "$OWN_COUNT" =~ ^[0-9]+$ && "$OWN_COUNT" -eq 0 ]]; then
    record ok "processes visible to this login" "0 (expected after hardening)"
  else
    record fail "processes visible to this login" "$OWN_COUNT (expected 0 — hidepid is not hiding them from this login)"
  fi
else
  record fail "processes visible to this login" "pgrep not found — cannot check"
fi

# 3. Root still sees everything (hidepid must never blind root).
if command -v sudo >/dev/null 2>&1 && command -v pgrep >/dev/null 2>&1; then
  ROOT_COUNT="$(sudo pgrep -c -u camplat 2>/dev/null || true)"
  ROOT_COUNT="${ROOT_COUNT:-0}"
  if [[ "$ROOT_COUNT" =~ ^[0-9]+$ && "$ROOT_COUNT" -gt 0 ]]; then
    record ok "processes visible to root" "$ROOT_COUNT (root is not blinded)"
  else
    record fail "processes visible to root" "$ROOT_COUNT — root should still see the running camplat processes"
  fi
else
  record fail "processes visible to root" "sudo or pgrep not found — cannot check"
fi

# 4. The three services that must be running.
if command -v systemctl >/dev/null 2>&1; then
  for svc in camplat-recorder camplat-api camplat-detect; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
      record ok "$svc" "active"
    else
      record fail "$svc" "not active"
    fi
  done
else
  record fail "camplat services" "systemctl not found — cannot check"
fi

# 5 & 6. Segment and detection freshness, read the same way camctl reads them
# (agent/segindex.mjs + agent/healthfacts.mjs), and detect-health.json. Run
# via sudo because the state dir belongs to the camplat service user; the
# script below only ever touches cameraId, timestamps and counts — never a
# camera's url, which is the only field in config.json that could carry a
# password, and which none of these modules return in the first place.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  record fail "recording freshness" "node not found on PATH — cannot check"
  record fail "detection freshness" "node not found on PATH — cannot check"
elif [[ ! -d "$APP_DIR/agent" ]]; then
  record fail "recording freshness" "no $APP_DIR/agent — is CAMPLAT_APP_DIR right?"
  record fail "detection freshness" "no $APP_DIR/agent — is CAMPLAT_APP_DIR right?"
else
  TMP_JS="$(mktemp --suffix=.mjs)"
  trap 'rm -f "$TMP_JS"' EXIT
  cat > "$TMP_JS" <<JSEOF
import { loadConfig } from "$APP_DIR/agent/recorder-service.mjs";
import { openIndex } from "$APP_DIR/agent/segindex.mjs";
import { indexPathFor, DEFAULT_PATHS } from "$APP_DIR/agent/config.mjs";
import { cameraFacts } from "$APP_DIR/agent/healthfacts.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const stateDir = process.env.CAMPLAT_STATE_DIR || DEFAULT_PATHS.stateDir;
const freshMs = Number(process.env.CAMPLAT_VERIFY_FRESH_MS || 120000);
const now = Date.now();

let segTotal = 0, segFresh = 0, segStale = 0, segNever = 0, segError = "";
try {
  const config = await loadConfig(stateDir);
  const index = openIndex(indexPathFor(stateDir));
  const cameraIds = config.cameras.map((c) => c.cameraId);
  const facts = cameraFacts(index, cameraIds);
  segTotal = cameraIds.length;
  for (const id of cameraIds) {
    const f = facts.get(id);
    if (!f || !f.lastSealedUtc) { segNever++; continue; }
    const age = now - Date.parse(f.lastSealedUtc);
    if (age <= freshMs) segFresh++; else segStale++;
  }
} catch (err) {
  segError = String((err && err.message) || err).split("\n")[0];
}

let detTotal = 0, detFresh = 0, detStale = 0, detNever = 0, detError = "";
try {
  const raw = await readFile(path.join(stateDir, "detect-health.json"), "utf8");
  const health = JSON.parse(raw);
  const cams = Array.isArray(health.cameras) ? health.cameras : [];
  detTotal = cams.length;
  for (const cam of cams) {
    // A gated (quiet) camera can go a whole keepalive between frame lines
    // without being stalled, so the gate's own last-window time counts too --
    // agent/detect-service.mjs warns any staleness check on lastFrameUtc must
    // also compare against gate.lastWindow.atUtc, or a healthy quiet camera
    // reads as stalled.
    const times = [cam.lastFrameUtc, cam.gate && cam.gate.lastWindow && cam.gate.lastWindow.atUtc]
      .filter((t) => typeof t === "string")
      .map((t) => Date.parse(t))
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) { detNever++; continue; }
    const newest = Math.max(...times);
    if (now - newest <= freshMs) detFresh++; else detStale++;
  }
} catch (err) {
  detError = String((err && err.message) || err).split("\n")[0];
}

console.log("SEG_TOTAL=" + segTotal);
console.log("SEG_FRESH=" + segFresh);
console.log("SEG_STALE=" + segStale);
console.log("SEG_NEVER=" + segNever);
console.log("SEG_ERROR=" + segError);
console.log("DET_TOTAL=" + detTotal);
console.log("DET_FRESH=" + detFresh);
console.log("DET_STALE=" + detStale);
console.log("DET_NEVER=" + detNever);
console.log("DET_ERROR=" + detError);
JSEOF

  OUT="$(sudo CAMPLAT_STATE_DIR="$STATE_DIR" CAMPLAT_VERIFY_FRESH_MS="$FRESH_MS" "$NODE_BIN" "$TMP_JS" 2>/dev/null || true)"
  rm -f "$TMP_JS"
  trap - EXIT

  SEG_TOTAL=0; SEG_FRESH=0; SEG_STALE=0; SEG_NEVER=0; SEG_ERROR=""
  DET_TOTAL=0; DET_FRESH=0; DET_STALE=0; DET_NEVER=0; DET_ERROR=""
  while IFS='=' read -r key val; do
    case "$key" in
      SEG_TOTAL) SEG_TOTAL="$val" ;;
      SEG_FRESH) SEG_FRESH="$val" ;;
      SEG_STALE) SEG_STALE="$val" ;;
      SEG_NEVER) SEG_NEVER="$val" ;;
      SEG_ERROR) SEG_ERROR="$val" ;;
      DET_TOTAL) DET_TOTAL="$val" ;;
      DET_FRESH) DET_FRESH="$val" ;;
      DET_STALE) DET_STALE="$val" ;;
      DET_NEVER) DET_NEVER="$val" ;;
      DET_ERROR) DET_ERROR="$val" ;;
    esac
  done <<< "$OUT"

  if [[ -n "$SEG_ERROR" ]]; then
    record fail "recording freshness" "could not read the index: $SEG_ERROR"
  elif [[ "$SEG_TOTAL" -eq 0 ]]; then
    record fail "recording freshness" "no cameras configured — nothing to check"
  elif [[ "$SEG_FRESH" -eq "$SEG_TOTAL" ]]; then
    record ok "recording freshness" "$SEG_FRESH/$SEG_TOTAL camera(s) sealed a segment within the last $((FRESH_MS/1000))s"
  else
    record fail "recording freshness" "$SEG_FRESH/$SEG_TOTAL fresh, $SEG_STALE stale, $SEG_NEVER never recorded"
  fi

  if [[ -n "$DET_ERROR" ]]; then
    record fail "detection freshness" "could not read detect-health.json: $DET_ERROR"
  elif [[ "$DET_TOTAL" -eq 0 ]]; then
    record fail "detection freshness" "no cameras in detect-health.json — nothing to check"
  elif [[ "$DET_FRESH" -eq "$DET_TOTAL" ]]; then
    record ok "detection freshness" "$DET_FRESH/$DET_TOTAL camera(s) have a frame or gate window within the last $((FRESH_MS/1000))s"
  else
    record fail "detection freshness" "$DET_FRESH/$DET_TOTAL fresh, $DET_STALE stale, $DET_NEVER never seen"
  fi
fi

# 7. A read-only camctl command still runs at all (proves the group change
# did not accidentally block the tooling itself).
if [[ -n "${NODE_BIN:-}" && -f "$APP_DIR/agent/camctl.mjs" ]]; then
  if sudo CAMPLAT_STATE_DIR="$STATE_DIR" "$NODE_BIN" "$APP_DIR/agent/camctl.mjs" audit --state-dir "$STATE_DIR" >/dev/null 2>&1; then
    record ok "camctl audit" "ran cleanly (read-only: nothing moved, deleted or written)"
  else
    record fail "camctl audit" "exited non-zero — run it by hand for detail: sudo node $APP_DIR/agent/camctl.mjs audit"
  fi
else
  record fail "camctl audit" "node or $APP_DIR/agent/camctl.mjs not found — cannot check"
fi

echo
echo "$((CHECKS - FAILS))/$CHECKS checks passed"
if [[ "$FAILS" -eq 0 ]]; then
  exit 0
else
  exit 1
fi
