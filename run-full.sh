#!/usr/bin/env bash
# The full run (2026-11-25). Removes every image this experiment uses, so that prepare pulls the newest :dev
# generator and engine images and rebuilds the client images on them; generates the combinations; prepares once
# (-f: the data is regenerated once, the combinations share it); then runs all combinations.
# Start detached: setsid nohup ./run-full.sh > output/run-full.log 2>&1 < /dev/null &
# Progress: output/STATUS. Logs: output/generate-combinations.log, output/prepare.log, output/run.log.
set -uo pipefail
cd "$(dirname "$0")"
source ~/.nvm/nvm.sh >/dev/null
mkdir -p output
status() { echo "$(date '+%F %T') $*" | tee -a output/STATUS; }
clean() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }
failed() { [ "$1" -ne 0 ] || clean "$2" | grep -q "Errored"; }

status "start (full run)"
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

npx jbr generate-combinations > output/generate-combinations.log 2>&1 || { status "FAILED: generate-combinations"; exit 1; }
status "preparing (log: output/prepare.log)"
npm run jbr -- prepare -f > output/prepare.log 2>&1
failed $? output/prepare.log && { status "FAILED: prepare"; exit 1; }
status "running all combinations (log: output/run.log)"
npm run jbr -- run > output/run.log 2>&1
failed $? output/run.log && { status "FAILED: run"; exit 1; }
status "DONE: results in combinations/combination_{0,1,2,3,4}/output (0 = derived full, 1 = pattern-only, 2 = derived full + extended blocks + bound composites, 3 = traversal only, 4 = traversal only with the default join)"
