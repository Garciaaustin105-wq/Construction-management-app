#!/usr/bin/env bash
#
# Stage 1 of LINUX-BUILD-PLAN.md: does the suite pass on this Linux box?
#
# Run it from anywhere, as any user, inside an unpacked release. It installs
# nothing, starts nothing, and needs no network. Everything goes into one text
# file for Austin to send back; nothing in it is a secret.
#
#   bash setup/stage1-check.sh [output-file]
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$ROOT/harness/run-all.mjs" ]; then
  >&2 echo "not inside a camplat release: $ROOT/harness/run-all.mjs is missing"
  exit 2
fi
OUT="${1:-$HOME/stage1-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ).txt}"
if [ -e "$OUT" ]; then
  echo "output file already exists: $OUT" >&2
  exit 2
fi
{
  echo "== camplat stage 1 check"
  if [ -f "$ROOT/VERSION" ]; then
    release=$(<"$ROOT/VERSION")
  else
    release="VERSION file missing"
  fi
  echo "release:  $release"
  echo "utc:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "kernel:   $(uname -r)"
  echo "machine:  $(uname -m)"
  if [ -f /etc/os-release ]; then
    pretty="$(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
  else
    pretty=unknown
  fi
  echo "os:       $pretty"
  echo "user:     $(id -un)"
  for tool in node ffmpeg ffprobe; do
    if command -v "$tool" >/dev/null 2>&1; then
      if [ "$tool" = node ]; then
        first=$("$tool" -v 2>/dev/null | head -n1)
      else
        first=$("$tool" -version 2>/dev/null | head -n1)
      fi
      echo "$tool: $first"
    else
      echo "$tool: NOT FOUND"
    fi
  done
  if ! command -v node >/dev/null 2>&1; then
    echo "RESULT: CANNOT RUN (node not found)"
    exit 3
  fi
  echo "== node harness/run-all.mjs"
  (cd "$ROOT" && node harness/run-all.mjs)
  run_code=$?
  echo
  if [ "$run_code" -eq 0 ]; then
    echo "RESULT: PASS"
  else
    echo "RESULT: FAIL (run-all exit $run_code)"
  fi
  exit $run_code
} 2>&1 | tee "$OUT"
status=${PIPESTATUS[0]}
echo "saved: $OUT"
exit $status
