#!/usr/bin/env bash
set -euo pipefail
cd /Users/billionjaepyo/projects/poke-pi
mkdir -p runs/.loop-supervisor
while true; do
  npm run harness -- critic --iterations 120 --poll-ms 1000 --port "${PORT:-3030}" >> runs/.loop-supervisor/critic.log 2>&1 || true
  sleep 3
done
