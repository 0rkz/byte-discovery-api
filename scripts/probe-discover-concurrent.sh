#!/usr/bin/env bash
# Probe /discover under concurrency and fail on any wrong 200.
#
# A sequential check passes ~90% of the time on a service that is broken under
# load, which is how the fail-open shipped on 2026-09-03 looked healthy. This
# sends N requests at concurrency C and reports every distinct answer.
#
# The throttle is `xargs -P`, a hard cap on concurrent workers. The first
# version used `while … & … wait -n` under `#!/bin/sh`: dash has no `wait -n`
# (the error was swallowed, so "concurrency 10" meant "all at once"), and even
# under bash a `jobs`-count throttle is loose — measured 8–9 requests in
# flight at "concurrency 5". `xargs -P 5` measured exactly 5.
#
# Usage: probe-discover-concurrent.sh http://127.0.0.1:3500 [total] [concurrency]
# Exit: 0 every 200 carried the modal catalog and none was degraded
#       1 at least one 200 carried a non-modal or degraded catalog (fail-open)
#       2 no response was a 200 at all (the service is down or fails closed)
set -eu
BASE="${1:?usage: probe-discover-concurrent.sh BASE [total] [concurrency]}"
TOTAL="${2:-60}"
CONC="${3:-10}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
export BASE DIR

# One request: HTTP code, feed count, degraded flag → one line in $DIR/out.
# Each line is a single short write with O_APPEND, so concurrent workers do
# not interleave.
probe_one() {
  local i=$1 code n
  code=$(curl -s -o "$DIR/b.$i" -w '%{http_code}' --max-time 30 "$BASE/discover" || echo 000)
  n=$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); print(len(d.get("feeds",[])), "degraded" if d.get("degraded") else "-")
except Exception: print("- -")' "$DIR/b.$i")
  echo "$code $n" >> "$DIR/out"
}
export -f probe_one

seq 1 "$TOTAL" | xargs -P "$CONC" -I{} bash -c 'probe_one "$1"' _ {}
[ -s "$DIR/out" ] || { echo "FAIL: no responses recorded"; exit 2; }

echo "count  http feeds degraded"
sort "$DIR/out" | uniq -c | sort -rn
OK=$(awk '$1==200' "$DIR/out" | wc -l)
UNAVAIL=$(awk '$1==503' "$DIR/out" | wc -l)
MODE=$(awk '$1==200 {print $2}' "$DIR/out" | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
BAD=$(awk -v m="$MODE" '$1==200 && ($2!=m || $3=="degraded")' "$DIR/out" | wc -l)
echo "200s: $OK; 503s: $UNAVAIL; modal feed count on 200s: ${MODE:-none}; wrong 200s: $BAD"
if [ "$OK" -eq 0 ]; then
  echo "FAIL: no 200 in $TOTAL responses ($UNAVAIL were 503) — nothing to judge the catalog on"
  exit 2
fi
[ "$BAD" -eq 0 ] || { echo "FAIL: $BAD of $TOTAL responses were 200 with a non-modal or degraded catalog"; exit 1; }
echo "OK: every 200 carried the modal catalog and none was degraded"
