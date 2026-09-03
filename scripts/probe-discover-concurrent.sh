#!/bin/sh
# Probe /discover under concurrency and fail on any wrong 200.
#
# A sequential check passes ~90% of the time on a service that is broken under
# load, which is how the fail-open shipped on 2026-09-03 looked healthy. This
# sends N requests at concurrency C and reports every distinct answer.
#
# Usage: probe-discover-concurrent.sh http://127.0.0.1:3500 [total] [concurrency]
set -eu
BASE="${1:?usage: probe-discover-concurrent.sh BASE [total] [concurrency]}"
TOTAL="${2:-60}"
CONC="${3:-10}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

i=1
while [ "$i" -le "$TOTAL" ]; do
  {
    code=$(curl -s -o "$DIR/b.$i" -w '%{http_code}' --max-time 30 "$BASE/discover" || echo 000)
    n=$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); print(len(d.get("feeds",[])), "degraded" if d.get("degraded") else "-")
except Exception: print("- -")' "$DIR/b.$i")
    echo "$code $n" >> "$DIR/out"
  } &
  [ "$(jobs -p | wc -l)" -ge "$CONC" ] && wait -n 2>/dev/null || true
  i=$((i + 1))
done
wait

echo "count  http feeds degraded"
sort "$DIR/out" | uniq -c | sort -rn
MODE=$(awk '$1==200 {print $2}' "$DIR/out" | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
BAD=$(awk -v m="$MODE" '$1==200 && ($2!=m || $3=="degraded")' "$DIR/out" | wc -l)
echo "modal feed count on 200s: ${MODE:-none}; wrong 200s: $BAD"
[ "$BAD" -eq 0 ] || { echo "FAIL: $BAD of $TOTAL responses were 200 with a non-modal or degraded catalog"; exit 1; }
echo "OK: every 200 carried the modal catalog and none was degraded"
