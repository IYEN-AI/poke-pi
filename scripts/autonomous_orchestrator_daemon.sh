#!/usr/bin/env bash
set -euo pipefail
cd /Users/billionjaepyo/projects/poke-pi
mkdir -p runs/.loop-supervisor
# Disabled when a single-controller strategy loop is running; otherwise this daemon
# can spawn competing actors and fight the main player process.
if [[ -f runs/.loop-supervisor/disable-autonomous-orchestrator ]]; then
  echo "autonomous_orchestrator_daemon disabled by sentinel" >> runs/.loop-supervisor/autonomous-orchestrator-daemon.log
  exit 0
fi
while true; do
  if [[ -f runs/.loop-supervisor/disable-autonomous-orchestrator ]]; then
    echo "autonomous_orchestrator_daemon disabled by sentinel" >> runs/.loop-supervisor/autonomous-orchestrator-daemon.log
    exit 0
  fi
  python3 scripts/autonomous_orchestrator.py >> runs/.loop-supervisor/autonomous-orchestrator-daemon.log 2>&1 || true
  sleep 50
done
