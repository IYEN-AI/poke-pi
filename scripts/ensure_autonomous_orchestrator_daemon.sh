#!/usr/bin/env bash
set -euo pipefail
cd /Users/billionjaepyo/projects/poke-pi
mkdir -p runs/.loop-supervisor
if pgrep -f 'scripts/autonomous_orchestrator_daemon.sh' >/dev/null 2>&1; then
  exit 0
fi
nohup bash scripts/autonomous_orchestrator_daemon.sh >> runs/.loop-supervisor/autonomous-orchestrator-daemon.log 2>&1 &
echo "started autonomous_orchestrator_daemon pid=$!"
