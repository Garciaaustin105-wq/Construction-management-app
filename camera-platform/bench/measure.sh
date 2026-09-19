#!/usr/bin/env bash
# measure.sh <phase> <seconds> <out-dir>
# Samples every 5 s: whole-machine CPU, per-process CPU by group, disk.
# Columns are found by HEADER NAME, never by position: sysstat moves columns
# between versions, and a positional parse reads a plausible wrong number.
set -euo pipefail
export LC_ALL=C

phase="$1"; duration="$2"; out="$3"
for t in mpstat pidstat iostat; do
  command -v "$t" >/dev/null || { echo "missing $t (install sysstat)" >&2; exit 2; }
done
(( duration > 0 && duration % 5 == 0 )) || { echo "duration must be a positive multiple of 5" >&2; exit 2; }

dir="$out/$phase"; mkdir -p "$dir"
n=$((duration / 5))
date +%s > "$dir/start.txt"

# Groups: node = recorder + api; ffmpeg = recorder ingest + live transmux;
# chrom = the browsers; mediamtx|srcpub = the synthetic cameras (NOT appliance
# cost, reported so it can be subtracted); detdec = detector-style decode.
mpstat -P ALL 5 "$n" > "$dir/mpstat.txt" &
pidstat -u -h 5 "$n" -C 'node|ffmpeg|chrom|mediamtx|srcpub|detdec' > "$dir/pidstat.txt" &
iostat -x -y -d 5 "$n" > "$dir/iostat.txt" &
wait
date +%s > "$dir/end.txt"

{
  echo "phase: $phase"
  echo "duration_s: $duration"
  echo "cores: $(nproc)"

  # Whole machine: only the "all" rows, never the per-core ones.
  awk '$2=="all" && $1!="Average:" { s+=$NF; k++ }
       END { printf "cpu_all_busy_pct: %.1f\n", k ? 100 - s/k : 0 }' "$dir/mpstat.txt"

  # Per group: sum %CPU across a group's processes within one sample, then
  # average those sums over samples. %CPU here is of ONE core (100 = one core).
  awk '
    /^#/ { for (i = 2; i <= NF; i++) col[$i] = i - 1; next }
    NF == 0 || !("%CPU" in col) { next }
    {
      ts = $1; cmd = $(col["Command"]); cpu = $(col["%CPU"]); seen[ts] = 1
      if (cmd ~ /^node/)                 g["node", ts]   += cpu
      else if (cmd ~ /^ffmpeg/)          g["ffmpeg", ts] += cpu
      else if (cmd ~ /chrom/)            g["chrom", ts]  += cpu
      else if (cmd ~ /mediamtx|srcpub/)  g["source", ts] += cpu
      else if (cmd ~ /^detdec/)          g["detdec", ts] += cpu
    }
    END {
      k = 0; for (ts in seen) k++
      split("node ffmpeg chrom detdec source", names, " ")
      for (j = 1; j <= 5; j++) {
        s = 0; for (ts in seen) s += g[names[j], ts]
        printf "cpu_%s_pct_of_one_core: %.1f\n", names[j], k ? s/k : 0
      }
    }' "$dir/pidstat.txt"

  # Disk: find the columns in the Device header of each block.
  awk '
    /^Device/ { for (i = 1; i <= NF; i++) h[$i] = i; inblk = 1; next }
    NF == 0 { inblk = 0; next }
    inblk && $1 !~ /^loop/ {
      d = $1; r[d] += $(h["rkB/s"]); w[d] += $(h["wkB/s"]); u[d] += $(h["%util"]); c[d]++
    }
    END { for (d in c) printf "disk_%s: read %.0f kB/s, write %.0f kB/s, util %.1f%%\n", d, r[d]/c[d], w[d]/c[d], u[d]/c[d] }
  ' "$dir/iostat.txt" | sort
} > "$dir/summary.txt"
cat "$dir/summary.txt"
