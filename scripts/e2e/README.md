# End-to-end harness

Live e2e harness for the autonomous dev system with per-phase, per-model, and
per-agent cost/token breakdown.

## Prerequisites

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Without a real API key the SDK hangs indefinitely — it has no auth fallback
when run outside an interactive Claude Code session.

## One-shot run

```bash
# clone/pull first, then from the repo root:
./scripts/e2e/run.sh "Build a React + Vite frontend for the dev-system dashboard"
```

The script:
- builds `dist/` if missing
- creates a clean work-dir (default `/tmp/autonomous-dev-e2e`)
- drops in a starter `autonomous-dev.config.json` with Opus orchestrator +
  Sonnet subagents (override by editing after first run)
- wipes prior state (keeps config + any git history in the work-dir)
- exec's the orchestrator in the foreground with `--verbose`

## Live monitor

In a second terminal:

```bash
node scripts/e2e/monitor.mjs /tmp/autonomous-dev-e2e/.autonomous-dev
```

You'll see a view refreshed every 10 seconds:

```
═══ e2e monitor @ 2026-... ═══
project: 3a5f2e1c  phase: development  tasks: 24  agents: 7  checkpoints: 4
events: 1452  phases-started: 5  rubric-retries: 2  total-cost: $6.41

── by phase ──
phase                cost       calls  input    output   cacheR   cacheC   hit%
development          $4.2018       38   412.5k   48.1k    3.2M    52.4k    88%
architecture         $0.9140        4    34.1k    5.2k   180.2k    8.0k    84%
ideation             $0.7210        3    22.4k    3.1k   112.0k    4.4k    83%
...

── by model ──
model                          cost       input    output   cacheR   hit%
claude-opus-4-6                $2.1220    58.0k    14.2k   480.0k    89%
claude-sonnet-4-6              $4.2880   412.0k    45.1k   3.1M      88%

── by agent (top 15) ──
agent                    cost       calls  input    output   cacheR
developer                $1.8010       15   145.0k   18.1k    1.3M
qa-engineer              $0.7214        4    48.0k    3.2k   240.0k
...
```

## What to watch for

### Token efficiency (Stream 1 gains)
- **`hit%`** by phase ≥70% for dev — confirms shared architecture-JSON
  prefix caching is working. <50% means prefixes aren't stable across
  calls; investigate `buildSharedTaskContext`.
- **`cacheR` > `input` many-fold** for dev phase: typical for
  architecture-heavy batches.
- **Per-model cost split** should lean heavily on Sonnet for dev; Opus
  dominant in ideation/architecture/review. If Opus usage shows up in a
  dev subagent, the subagent model override wasn't passed.

### Flow compliance
- `phases-started` should monotonically increase through the lifecycle
  (ideation → specification → architecture → ...). Skipped phases are OK
  only if `--quick` flag is used.
- `rubric-retries` ≤ 3 per phase. Higher means rubric is failing to
  converge — add to backlog.

### Data integrity
- `checkpoints` grows with each phase; should stay ≤ N×3 (Stream 2
  sliding window). Verify with `ls .autonomous-dev/` for `.lock` file
  that's removed cleanly after each saveState.

### Parallelism (Stream 4)
- For a dev phase with 5+ tasks, `event-log` should show two batches
  starting within a short window when their globs are disjoint. Check:
  ```bash
  grep 'orchestrator.phase.start.*development' .autonomous-dev/events/*.jsonl
  ```

### Self-improvement (Stream 4 scoring)
- Look for `[optimize]` lines in the orchestrator output showing
  `agentScore=X overall=Y weighted=Z baseline=W -> ACCEPT/REJECT`. Hybrid
  should lead to per-agent specialization preserving accepts.

## Stop rules (judgment-based)

The orchestrator itself won't stop — you're the supervisor. Interrupt
(`Ctrl+C` in the orchestrator terminal) when you see any of:

- Same phase stuck >10 min with no new `agent.query.end` events
- `total-cost` crossing a threshold you're not ready to spend
- Repeated rubric `failed` verdict on the same phase
- State-file parse errors in monitor (`[monitor] error: ...`)

On interrupt, the Stream 3 changes ensure in-flight queries are cancelled
via `AbortSignal` and state is saved. Resume with:

```bash
node dist/index.js run --resume <session-id>
```

## Backlog capture (non-critical issues)

As the run progresses you'll notice smaller issues that aren't worth
stopping for (a misnamed file, a warning in a phase, a sub-optimal decision
by an agent). Keep a plain markdown file alongside:

```bash
$WORK_DIR/e2e-backlog.md
```

Suggested format:

```md
## [BL-001] <short title>
**When:** phase=development, batch=2, agent=frontend-dev
**Observation:** ...
**Severity:** low
**Proposed fix:** ...
```

After the run, this feeds into a follow-up fix pass.

## Stopping and cleanup

```bash
# In the orchestrator terminal
Ctrl+C              # graceful stop; state saved

# Full cleanup
rm -rf /tmp/autonomous-dev-e2e
```

## Notes

- `--budget <usd>` flag can cap total spend if you want a safety valve.
  Omit it for an "until-done" run (the spec-sheet approach).
- `--quick` skips env-setup/review/ab-testing/monitoring for faster
  iteration when validating the dev phase only.
- `--confirm-spec` pauses after ideation so you can review the generated
  spec before architecture begins (useful for first runs).
