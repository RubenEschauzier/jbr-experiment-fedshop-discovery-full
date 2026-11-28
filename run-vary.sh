#!/usr/bin/env bash
# The federation-size axis (A2 of the evaluation plan): scripts/vary-scale.js with vary-n-pods.json. Per point it
# regenerates the federation (the known federation fixed, the discoverable part scaled), checks it, and runs the
# point's combinations.
#
# Start detached:
#   setsid nohup ./run-vary.sh > output/run-vary.log 2>&1 < /dev/null &               # x0.5, x1, x2
#   setsid nohup ./run-vary.sh --include 4 > output/run-vary.log 2>&1 < /dev/null &   # also x4, if x2 passes its gate
# Progress: output/STATUS. Logs: output/generate-combinations.log, output/vary.log. Results: npm run vary -- status.
# Arguments go to the script: --include <labels>, --force, --ignore-gate, --ignore-checks.
#
# Images: on a fresh start (no complete point yet) this removes every image the experiment uses, so that prepare
# pulls the newest :dev generator and engine images and rebuilds the client images on them. Once a point is
# complete it keeps them: every point must come from the same generator and engine (the script checks both), so a
# later run, such as x4 after x2, uses the images of the earlier points. --fresh-images removes them anyway; the
# script then stops at the first point whose images differ from the complete points'.
set -uo pipefail
cd "$(dirname "$0")"
source ~/.nvm/nvm.sh >/dev/null
mkdir -p output
status() { echo "$(date '+%F %T') $*" | tee -a output/STATUS; }

fresh=0
args=()
for arg in "$@"; do
  if [ "$arg" = "--fresh-images" ]; then fresh=1; else args+=("$arg"); fi
done
complete=$(ls -d output-*/point.json 2>/dev/null | grep -v '\.replaced-' | wc -l)

status "start (vary number of pods) ${args[*]:-}"
if [ "$complete" -eq 0 ] || [ "$fresh" -eq 1 ]; then
  images=(
    rubeneschauzier/fedshop-discovery-generator:dev
    rubeneschauzier/comunica-query-sparql-link-traversal-solid-derived-resources:dev
    "$(sed -n 's/.*"virtuosoImage": "\([^"]*\)".*/\1/p' jbr-experiment.json.template)"
    $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^jbr-experiment-fedshop-discovery-full-experiment-combination_')
  )
  for image in "${images[@]}"; do
    docker image inspect "$image" > /dev/null 2>&1 && docker rmi -f "$image" >> output/STATUS 2>&1
  done
  status "removed images: ${images[*]}"
else
  status "kept the images: $complete point(s) complete (--fresh-images removes them)"
fi

npx jbr generate-combinations > output/generate-combinations.log 2>&1 || { status "FAILED: generate-combinations"; exit 1; }
status "running the points (log: output/vary.log)"
npm run vary -- run "${args[@]}" > output/vary.log 2>&1 || { status "FAILED: vary (see the end of output/vary.log)"; exit 1; }
status "DONE: results in output-<scale>/combination_<i>/ (1 = pattern-only, 2 = derived full + extended blocks + bound composites); npm run vary -- status"
