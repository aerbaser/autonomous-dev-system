# Vibe Coding Review: autonomous-dev-system

A deep analysis of the system's UX, architecture, and "magic" factor from the perspective of modern vibe coding tools (Cursor, Bolt, v0, Devin, Claude Code).

---

## 1. The "Magic Moment" Problem

**Current time-to-magic: 10-30 minutes. Target: under 60 seconds.**

The user runs `autonomous-dev run --idea "trading bot"` and then... waits. The system sequentially calls Claude for domain analysis, spec generation, architecture design, environment setup — all before a single line of project code exists. This is the fundamental UX anti-pattern.

Compare with tools that work:
- **Bolt/v0**: First render in <5 seconds. You see HTML before the LLM finishes.
- **Cursor**: Inline diff appears as tokens stream in. You see progress character by character.
- **Devin**: Shows a plan immediately, then starts executing with visible terminal output.

In `orchestrator.ts` (line 84-121), the main loop is synchronous and phase-gated. The user cannot see or interact with anything until `ideation` + `architecture` + `environment-setup` all complete — which means 3 full LLM roundtrips (each potentially 10+ turns with WebSearch) before any code generation begins.

**The first "wow" moment — seeing actual code appear in files — doesn't happen until phase 4 (development), after at least 15-20 minutes of opaque processing.**

---

## 2. Feedback Loops: The Silent Black Box

### What the user sees

The entire output is `console.log` lines like:
```
[orchestrator] Phase 1: ideation
[ideation] Generating product specification...
[ideation] Spec generated: 8 user stories
[orchestrator] Transition: ideation -> specification
```

That's it. No streaming of LLM thought process. No progress bars. No preview of what's being generated.

### What's missing

**2a. No streaming output from agents.** In `sdk-helpers.ts` (line 30-58), `consumeQuery()` discards all intermediate messages — it only processes `result` and `api_retry` events. Every other message type (assistant text, tool calls, tool results) is silently dropped. This is the biggest UX gap. The user has zero visibility into what agents are thinking or doing.

Compare: Cursor shows every token as it streams. Devin shows its terminal and browser in real-time. Even a basic `process.stdout.write()` of partial text would transform the experience.

**2b. No progress indicator.** The user has no idea whether ideation will take 30 seconds or 5 minutes. There's no task count, no ETA, no spinner. The `development-runner.ts` does log batch progress (line 158-162), but only after each batch completes — not during.

**2c. No intermediate artifacts.** The spec, architecture, and agent blueprints are generated and stored in `state.json` as raw JSON, but never presented to the user in a readable format. v0 shows you the component tree. Bolt shows the file explorer updating in real-time. This system generates a JSON blob and moves on.

---

## 3. Escape Hatches: No Course Correction

### 3a. No user interaction during execution

The system runs fully autonomously with `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true` (used in every single `query()` call across all phases). Once started, there's no way to:
- Approve/reject the generated spec before architecture begins
- Steer architecture decisions (e.g., "use PostgreSQL, not MongoDB")
- Pause development to fix a wrong approach
- Skip a phase that isn't relevant

The `AskUserQuestion` tool is listed in the product-manager agent's tools (`base-blueprints.ts` line 59), but it's never in the `allowedTools` list of any actual `query()` call. It's a phantom capability.

### 3b. No edit-and-resume

If the user sees a bad spec in `state.json` and manually edits it, there's no command to say "resume from architecture with this modified spec." The `--resume` flag in `index.ts` (line 22) accepts a session ID, but the orchestrator (`orchestrator.ts` line 62-128) doesn't actually use `_resumeSessionId` — it's an unused parameter (note the underscore prefix).

### 3c. Phase transitions are hard-coded

`VALID_TRANSITIONS` in `project-state.ts` (line 186-199) is a fixed DAG. The user cannot skip phases, reorder them, or add custom phases. If you don't need A/B testing or monitoring, you still have to go through them (or the system just stops at the prior phase with "No transition specified" — line 119).

---

## 4. Iteration Speed

### The idea-to-code loop is extremely slow

Rough estimate for a medium-complexity idea:
1. Ideation: 2-3 min (WebSearch + spec generation, 10 turns)
2. Architecture: 2-3 min (WebSearch + design, 10 turns)
3. Environment setup: 1-2 min (WebSearch + install, 15 turns for stack research)
4. Development: 5-20 min (200 maxTurns per batch, multiple batches)

**Total: 10-30 minutes before you can look at any code.** And if review or testing sends it back to development, add another 5-20 minutes.

Bolt generates a working app in 30 seconds. v0 renders a component in 5. Even Devin, which does full multi-step coding, shows you working code within 2-3 minutes.

### No hot-reload or incremental builds

Every phase runs from scratch. There's no "just regenerate the API endpoint for user story US-003" — it decomposes all user stories, batches all tasks, and runs them all. The checkpoint system (`PhaseCheckpoint` in `project-state.ts` line 146-152) does skip completed tasks, but there's no way to target a specific task for re-implementation.

---

## 5. Agent Orchestration: Multi-Agent vs. Single Agent

### The multi-agent approach adds overhead without clear benefit

In `development-runner.ts` (line 387-419), `buildBatchAgents()` creates a separate agent per task. But the execution prompt (line 460-478) tells a lead agent to "delegate to the corresponding dev-* subagent." This means:

1. The orchestrating agent reads the task list
2. It calls each dev-* subagent
3. Each subagent reads the codebase independently (no shared context)
4. The orchestrating agent verifies the result

This is 3x the token usage vs. a single agent doing all tasks sequentially with shared context. And the result-parsing logic (line 528-543) is fragile — it searches for task titles in the result text to determine success/failure, which will break on any non-trivial output.

### Where multi-agent DOES make sense (but isn't exploited)

The domain-specific agents (quant researcher, risk manager, etc.) are a genuinely good idea. But they're created during architecture phase (`factory.ts` line 10-55) and then... never specifically used. The development phase creates generic `dev-*` agents per task, ignoring the domain specialists entirely. The base agent definitions are passed to `buildBatchAgents()` but only as fallback agents, not as task-specific specialists.

---

## 6. Self-Improvement: Premature but Well-Designed

### The good

The optimizer architecture is legitimately solid:
- Hill-climbing with convergence detection (`convergence.ts`) — proper stagnation and plateau checks
- Multiple mutation types (`mutation-engine.ts` line 72-106) — prompt, tool config, phase logic, quality threshold
- Worktree sandbox isolation (`sandbox.ts` line 175-218) — mutations can't corrupt the main repo
- Version tracking (`versioning.ts`) — prompt history is preserved
- The benchmarks (`benchmarks.ts` line 210-309) are well-designed with weighted scoring

### The premature

This system cannot yet reliably generate a working project. Optimizing agent prompts when the basic flow has never been validated end-to-end is premature. The optimizer costs real money per iteration (multiple LLM calls per benchmark per mutation per iteration), and without a working baseline, the scores are meaningless.

Additionally, the `optimizer` command is completely separate from `run`. There's no integration point — you can't say "after development, optimize the developer agent based on how many tests passed." The self-improvement is a disconnected sidecar, not a feedback loop.

### The missing

The optimizer only mutates agent prompts and tools. It doesn't optimize:
- The orchestration order (maybe some projects should skip A/B testing)
- The decomposition strategy (how many tasks per story)
- The temperature / max tokens per agent
- Which phases use `opus` vs `sonnet` vs `haiku`

---

## 7. Missing Vibe Coding Patterns

### 7a. No preview / live output
Every successful vibe coding tool shows you what's being built AS it's being built. This system shows log lines. The minimum viable version: stream the files being written to stdout as they're created.

### 7b. No undo / version control integration
Cursor creates checkpoints. Bolt has "revert to this version." This system creates git commits per task but has no UI to compare versions or roll back to a specific checkpoint.

### 7c. No interactive refinement
"Make the button bigger" is the core vibe coding interaction. This system has no way to take a working output and iteratively refine it. Every run is from-scratch.

### 7d. No cost transparency
Each phase uses Claude, but the user has no idea what it costs until the final log line. In `development-runner.ts` line 158-162, cost is logged after each batch, but only as a small detail. There's no upfront estimate, no budget limit, no "this will cost approximately $X, proceed?"

### 7e. No template / starter support
Bolt and v0 can start from templates. This system always starts from a raw idea string, which means it reinvents the wheel for every React app, every API server, every CLI tool.

### 7f. No browser preview for web projects
Bolt's killer feature is the inline browser preview. This system deploys to staging but has no way to show the user what the app looks like during development.

---

## 8. Concrete Improvements (Prioritized)

### P0 — Make it usable

**1. Add streaming output to `consumeQuery()` in `src/utils/sdk-helpers.ts`.**
Currently line 33-57 discards all non-result messages. Add an `onMessage` callback that streams assistant text and tool calls to stdout. This alone transforms the experience from "black box" to "I can see what's happening."

```typescript
// sdk-helpers.ts — add onMessage callback to consumeQuery signature
export async function consumeQuery(
  queryStream: Query,
  label?: string,
  onMessage?: (msg: SDKMessage) => void  // NEW
): Promise<QueryResult>
```

**2. Add a `--confirm-spec` flag to `src/index.ts` that pauses after ideation.**
Display the generated spec in a readable format and ask the user to approve before continuing. This is a 20-line change in `orchestrator.ts` — add a conditional `await askUser()` between ideation and architecture.

**3. Enable resume from any phase in `orchestrator.ts` (line 62-128).**
The `_resumeSessionId` parameter is unused. Implement it: load state, check `state.currentPhase`, pass the session ID to the phase handler. Also make `--phase` work without requiring prior state for early phases.

### P1 — Make it fast

**4. Parallelize ideation sub-steps in `src/phases/ideation.ts`.**
Domain analysis and spec generation already run in parallel (line 47-48), which is good. But architecture should start as soon as spec is done — don't wait for the orchestrator loop to tick. Consider starting environment setup in parallel with development for non-critical steps.

**5. Add a `--quick` mode that skips environment-setup, A/B testing, and monitoring.**
Most users want idea → code → tests → done. The full lifecycle is enterprise-grade but kills iteration speed for prototyping. In `orchestrator.ts`, add a config flag that changes `VALID_TRANSITIONS` to skip non-essential phases.

**6. Add a `--template` flag to skip ideation/architecture for known project types.**
Pre-built specs and architectures for "Next.js SaaS", "Python CLI tool", "REST API with auth" would cut time-to-code by 5-10 minutes. Store in `templates/` directory, load via config.

### P2 — Make it feel magical

**7. Add a real-time file watcher output to development phase.**
In `development-runner.ts`, after each task completes, list the files that were created/modified. Better yet, use the `auditLoggerHook` data (`hooks/audit-logger.ts`) to show a live feed of file operations.

**8. Add cost estimation before execution.**
In `orchestrator.ts`, before starting the main loop, estimate the number of phases and LLM calls. Show something like: "Estimated cost: $2-5 for full lifecycle, $0.50-1 for development only."

**9. Generate a project README as the first visible artifact.**
Before writing any code, have the architecture phase generate a `README.md` with the project description, tech stack, and getting started instructions. This is the user's first tangible "thing" — and it appears within the first 2-3 minutes.

**10. Wire domain-specific agents into task assignment.**
In `development-runner.ts` `buildBatchAgents()` (line 387-419), match tasks to domain specialist agents based on task description. If a "quant-researcher" agent exists and the task is about trading strategies, assign it. Currently these agents are created but never used for actual work.

---

## 9. Architecture Strengths

Despite the UX gaps, the underlying architecture has real merit:

- **Phase state machine** (`project-state.ts` line 186-199) is clean and extensible
- **Checkpoint system** enables crash recovery — genuinely useful for long-running agents
- **Security hook** (`hooks/security.ts`) with deny patterns is a solid safety net
- **Quality gate hook** (`hooks/quality-gate.ts`) running tsc + tests after every task is the right pattern
- **Agent registry with versioned blueprints** (`agents/registry.ts`) that persist as `.md` files is elegant
- **Benchmark-driven optimization** with weighted scoring is the right approach for self-improvement
- **Retry with exponential backoff** (`utils/retry.ts`) with retryable/fatal error classification is production-grade
- **Worktree sandbox** for mutation testing is a clever isolation strategy

The engineering is solid. The gap is entirely in the user-facing layer.

---

## 10. Summary

| Dimension | Score | Key Issue |
|-----------|-------|-----------|
| Magic moment | 2/10 | 15+ minutes before any code appears |
| Feedback loops | 1/10 | Console logs only, no streaming, no preview |
| Escape hatches | 1/10 | Fully autonomous, no user control points |
| Iteration speed | 2/10 | Full lifecycle is 10-30 min, no incremental mode |
| Agent orchestration | 5/10 | Good design, domain agents unused, overhead > benefit |
| Self-improvement | 7/10 | Well-designed but premature and disconnected |
| Missing patterns | 3/10 | No preview, no undo, no interactive refinement |

**The system is an excellent backend for autonomous development, but it's invisible to the user.** The fix is not more agents or more phases — it's a presentation layer that makes the existing work visible, interruptible, and iterative.

The single highest-impact change: **stream LLM output to the user in real-time** (`sdk-helpers.ts`). Everything else follows from making the process visible.
