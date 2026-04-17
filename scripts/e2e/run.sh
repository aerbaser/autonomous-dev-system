#!/usr/bin/env bash
# End-to-end run for the autonomous dev system.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./scripts/e2e/run.sh "<project idea>" [work-dir]
#
# Defaults work-dir to /tmp/autonomous-dev-e2e. Starts the orchestrator in
# the foreground and the live monitor in a second terminal pane (or prints
# the monitor command if tmux/screen isn't available).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDEA="${1:?Usage: $0 \"<project idea>\" [work-dir]}"
WORK_DIR="${2:-/tmp/autonomous-dev-e2e}"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "error: ANTHROPIC_API_KEY is not set." >&2
  echo "  export ANTHROPIC_API_KEY=sk-ant-..." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "building autonomous-dev-system..."
  (cd "$REPO_ROOT" && npm ci && npm run build)
fi

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [[ ! -f autonomous-dev.config.json ]]; then
  cp "$REPO_ROOT/scripts/e2e/config.example.json" autonomous-dev.config.json
  echo "copied default config: autonomous-dev.config.json (Opus orchestrator + Sonnet subagents)"
fi

mkdir -p .autonomous-dev/events
# Clean per-run state but preserve the config and any prior git history in the work dir.
rm -f .autonomous-dev/state.json .autonomous-dev/sessions.json
rm -f .autonomous-dev/events/*.jsonl

echo "───────────────────────────────────────"
echo "repo       : $REPO_ROOT"
echo "work-dir   : $WORK_DIR"
echo "config     : $(pwd)/autonomous-dev.config.json"
echo "state-dir  : $(pwd)/.autonomous-dev"
echo "monitor cmd: node $REPO_ROOT/scripts/e2e/monitor.mjs $(pwd)/.autonomous-dev"
echo "───────────────────────────────────────"
echo ""
echo "tip: open a second terminal and run the monitor cmd above to see live per-phase/per-model/per-agent breakdown."
echo ""
sleep 2

exec node "$REPO_ROOT/dist/index.js" run \
  --idea "$IDEA" \
  --config autonomous-dev.config.json \
  --verbose
