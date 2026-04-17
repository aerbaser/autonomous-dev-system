# Plan: Agent Teams Native Execution and Spend Hardening

> Source: Telegram OI E2E findings, spend regression observed on 2026-04-10, and operator requirements captured in this thread.

## Objective

Rework the autonomous dev system so that:

- the main execution path uses a native `agent teams` topology as the primary runtime
- Opus acts as the team lead and orchestrates Codex and other specialists inside that team
- child implementation work is done by native team members and their allowed subagents, not by shelling out through a manual `codex exec` proxy loop
- spend, retries, and quota burn are attributable, bounded, and resumable
- the system fails loudly when the native topology is unavailable instead of silently falling back to a more expensive proxy mode

## Non-Negotiable Architectural Decisions

- **Primary runtime**: one native execution team per run. The run must not emulate a team by prompting a single lead agent to impersonate a coordinator while separately forwarding work through shell-wrapped Codex sessions.
- **Orchestration model**: Opus is the team lead. Codex and other role agents are first-class team members. Inside a team member, parallelization through the `Agent` tool is allowed only for true subagent work scoped to that member.
- **No double orchestration**: do not pay for an outer Claude orchestration loop and an inner Codex orchestration loop for the same task.
- **No custom question bus for now**: do not build a bespoke ask/reply channel with the orchestrator. If team execution is native, use native team/thread behavior only. Human-loop tooling can be reconsidered later, but it is not part of this fix.
- **Fail closed on unsupported topology**: if native agent-team execution for Codex-backed coding cannot be established, disable the feature and surface a clear blocker. Do not silently degrade to the current proxy pattern.
- **Strict task receipts**: a task is complete only if there is a structured receipt tying together agent identity, session ids, changed files, verification commands, and outcome.
- **Retry semantics**: retries must resume from the last durable checkpoint and must not restart the whole development phase by default.
- **Spend governance**: every phase and every team member must have an explicit budget envelope, concurrency ceiling, and retry policy.

## Product Scope Decisions For Validation

These are the product-level assumptions the system should validate during the next Telegram OI scenario:

- **Current MVP UI contract**: read-only, polling-first dashboard
- **Current stable reads**: OI series, signals, symbols, exchanges, health, metrics
- **Canonical symbol model**: exchange-agnostic perpetual symbol format
- **Health/freshness**: first-class product surface, not a debug-only concern
- **Future scope**: rules CRUD, admin mutation APIs, and live streams stay out of the critical-path validation until the native team runtime is fixed

## Success Metrics

- A single Telegram OI E2E run reaches at least `development` and preferably completes without exhausting the provider usage window.
- The system can answer, after the run, all of the following:
  - how many team members were created
  - which model each member used
  - how many turns each member consumed
  - which retries happened and why
  - which tasks were completed by which member
  - what percentage of total spend was coordination versus actual implementation
- Development retries resume from the failed batch, not from batch 1.
- No task can be marked successful from freeform text alone.
- No proxy artifact can claim `blocked` while the system simultaneously records the same task as completed.

---

## Phase 1: Build a Spend and Topology Forensics Layer

**User stories**: As an operator, I need to understand where spend and quota burn actually came from, so that I can stop hidden orchestration waste before scaling the system.

### What to build

Create a run ledger that captures the real runtime topology and cost flow for every phase. The ledger must distinguish:

- root phase coordinator sessions
- team lead sessions
- child agent sessions
- subagent sessions spawned by child agents
- rubric and grader sessions
- memory capture sessions
- retries and replayed work

Add explicit reason codes for failures such as:

- provider_limit
- provider_rate_limit
- invalid_structured_output
- verification_failed
- blocked_filesystem
- unsupported_team_runtime

This phase should not change the orchestration model yet. Its job is to make the current system measurable enough to prove where the waste is happening.

### Acceptance criteria

- [ ] Every run produces a machine-readable topology and spend ledger.
- [ ] Every session is attributed to a phase, role, and task when applicable.
- [ ] Provider-limit failures are recorded as first-class failure reasons.
- [ ] The Telegram OI `r4` style run can be post-analyzed without reading raw console logs manually.

---

## Phase 2: Replace Proxy-Based Codex Delegation With Native Agent Teams

**User stories**: As an operator, I need Codex-backed coding work to run inside the native agent-team model, so that orchestration overhead does not explode and team behavior is consistent.

### What to build

Replace the current proxy pattern with a real team runtime abstraction:

- one primary team is instantiated for the run or for the development phase
- Opus is the team lead
- Codex coding agents are team members, not shell-invoked proxies
- domain specialists are team members when needed
- child parallelism is allowed only inside a team member through the native `Agent` tool, not by launching a second orchestration stack

The system must refuse to enable `Codex-backed subagents` unless it can do so through this native team path.

### Acceptance criteria

- [ ] The main run path no longer depends on a shell-wrapped `codex exec` proxy for task execution.
- [ ] A completed run records a primary team topology with leader and member identities.
- [ ] Codex-backed coding work runs as native team member execution, not as prompt forwarding.
- [ ] If native team execution is unavailable, the run fails fast with a clear unsupported-runtime error.

---

## Phase 3: Remove Double Orchestration and Coordination Waste

**User stories**: As an operator, I need to stop paying twice for coordination on the same task, so that heavy development phases do not drain my subscription window.

### What to build

Redesign development execution so that:

- there is no separate “lead developer pretending to orchestrate” prompt loop when a native team already exists
- task routing happens through explicit team assignment rules
- rubric evaluation, memory capture, and debug observers are not automatically turned on in expensive coding batches unless policy says they are necessary
- observer roles become an opt-in debug tier, not a default part of the critical path

This phase should also define a target coordination ratio, such as keeping orchestration overhead below a chosen fraction of total run spend.

### Acceptance criteria

- [ ] Development execution does not create a second orchestration loop around native team members.
- [ ] Debug observers can be disabled entirely for production runs.
- [ ] Expensive auxiliary agents are policy-gated and attributed separately from core execution.
- [ ] A run report can show coordination spend versus implementation spend.

---

## Phase 4: Add Hard Spend Governance and Quota Protection

**User stories**: As an operator, I need the run to stay inside predictable spend and quota envelopes, so that one long scenario cannot burn a large share of my usage window unexpectedly.

### What to build

Introduce hard controls at the phase, team, and agent levels:

- per-phase spend ceiling
- per-role spend ceiling
- maximum concurrent child agents
- maximum retries per failure class
- escalation policy for provider-limit errors
- cheap failure path for repeated identical failures

When the system detects a provider-limit condition, it must not keep replaying the same expensive setup path. It should either:

- checkpoint and stop cleanly
- downgrade optional work
- or wait for a resumable window if policy explicitly allows it

### Acceptance criteria

- [ ] The system can stop before burning through repeated identical retries.
- [ ] A provider-limit error does not restart the development phase from scratch.
- [ ] Phase-level and role-level spend caps are configurable and enforced.
- [ ] The run report includes which policy stopped or downgraded execution.

---

## Phase 5: Make Checkpointing and Resume Semantics Truly Durable

**User stories**: As an operator, I need retries and resumes to continue from real progress, so that a failure in batch 3 does not replay batches 1 and 2.

### What to build

Strengthen the checkpoint system so that it stores:

- completed task receipts
- pending task queue
- active team topology
- verification outcomes
- failure reason for the last interrupted batch

Retries should default to:

- same batch resume when safe
- same task retry when only one task failed
- phase restart only when the phase state is provably invalid

### Acceptance criteria

- [ ] A development failure after several successful batches resumes from the last incomplete batch by default.
- [ ] Completed tasks are not re-run unless explicitly invalidated.
- [ ] Checkpoints contain enough information to reconstruct the execution frontier.
- [ ] Resume behavior is deterministic and covered by integration tests.

---

## Phase 6: Replace Heuristic Task Success With Structured Receipts

**User stories**: As an operator, I need to trust that a task marked complete was actually completed by the intended agent, so that E2E results are auditable.

### What to build

Introduce a strict task receipt format for every delegated task. Each receipt should include:

- task id
- task title
- team member id
- agent role
- model
- session ids
- branch name when applicable
- commit sha when applicable
- changed files
- verification commands executed
- verification outcomes
- final status: success, failed, blocked, partial
- failure reason code when not successful

The system must reject freeform fallback success in the main path. Freeform text can be retained only as a debug attachment.

### Acceptance criteria

- [ ] No task can be marked successful from a generic text heuristic.
- [ ] A blocked task cannot be persisted as completed.
- [ ] Each completed task links to one authoritative structured receipt.
- [ ] Audit logs can answer which agent changed which files for each task.

---

## Phase 7: Normalize Runtime Context and Team Inputs

**User stories**: As an operator, I need delegated work to start with the right root path and environment assumptions, so that agents do not waste tokens correcting the prompt.

### What to build

Standardize the execution envelope delivered to team members:

- canonical project root
- canonical writable root
- canonical branch context
- explicit package root when monorepo or subproject layouts exist
- explicit allowed verification commands
- explicit environment assumptions for the task

This phase should remove the possibility that agents are told to work in a nonexistent nested project path unless that path is validated up front.

### Acceptance criteria

- [ ] Team members always receive a validated project root.
- [ ] Invalid nested-root prompts are impossible in the main path.
- [ ] Environment assumptions are visible in structured task input.
- [ ] The next Telegram OI scenario no longer shows path self-correction waste.

---

## Phase 8: Tighten Auxiliary Loops So They Do Not Inflate Core Runs

**User stories**: As an operator, I need quality gates, graders, and memory capture to help rather than silently double the cost of the run.

### What to build

Rebalance auxiliary execution:

- rubric grading should be cheap, bounded, and disabled where it is not decision-critical
- memory capture should be sampled or stage-gated
- debug watchers should be off by default
- quality-fix loops should be capped and receipt-driven

This phase should define which loops are:

- always-on
- debug-only
- nightly-only
- explicit operator opt-in

### Acceptance criteria

- [ ] Core runs have a minimal auxiliary profile by default.
- [ ] Expensive debug observers are not part of the default execution contract.
- [ ] Grader and memory capture usage is bounded and visible in the spend ledger.
- [ ] The system can run a standard E2E scenario without auxiliary-loop amplification.

---

## Phase 9: Validate Native Team Execution on the Telegram OI Scenario

**User stories**: As an operator, I need a repeatable benchmark scenario proving that the new runtime is actually better, not just theoretically cleaner.

### What to build

Re-run the same Telegram OI scenario as the canonical benchmark. Measure:

- wall-clock time
- spend by role
- number of team members
- number of retries
- batch resume behavior
- number of completed tasks
- whether development finishes
- whether frontend contract remains aligned with generated artifacts

Use the scenario as the gating benchmark for shipping the new runtime.

### Acceptance criteria

- [ ] The scenario reaches development with native team execution.
- [ ] The scenario no longer burns quota through replayed development restarts.
- [ ] Spend attribution clearly shows reduced coordination overhead.
- [ ] The run leaves trustworthy receipts and auditable task outcomes.

---

## Phase 10: Promote Self-Improvement to a Controlled Offline Path

**User stories**: As an operator, I want the system to improve over time without interfering with high-value live runs.

### What to build

Keep self-improvement, but move it firmly out of the critical path:

- benchmark-driven optimizer remains available through `optimize` and `nightly`
- live `run` execution should not mutate prompts or execution policy implicitly
- learnings from live runs should be captured as benchmark inputs and policy changes, not inline mutation

This phase formalizes a separation:

- live runs execute product work
- nightly runs optimize prompts and runtime policy

### Acceptance criteria

- [ ] Live runs do not perform prompt evolution inline.
- [ ] Self-improvement remains available as an offline, benchmarked workflow.
- [ ] Live-run findings can be fed into nightly optimization without changing live semantics.
- [ ] Operator can compare pre- and post-optimization benchmark results safely.

---

## Recommended Delivery Order

1. Phase 1
2. Phase 4
3. Phase 5
4. Phase 6
5. Phase 7
6. Phase 2
7. Phase 3
8. Phase 8
9. Phase 9
10. Phase 10

Rationale:

- first make spend and retries measurable
- then stop the biggest waste multipliers
- then replace the runtime topology
- then validate with the Telegram OI benchmark

## Release Gates

Do not ship the native Codex team mode as complete until all are true:

- a run ledger exists
- development retries resume correctly
- structured task receipts replace heuristic success
- proxy mode is removed from the main path or explicitly unsupported
- the Telegram OI benchmark demonstrates reduced orchestration overhead and no catastrophic quota burn

## Explicitly Rejected Shortcuts

- keeping the current `codex exec` proxy and merely tuning prompts
- adding more retries to provider-limit failures
- building a bespoke operator chat bus before fixing native team execution
- claiming task success from text summaries without structured receipts
- enabling heavy observer agents in the default critical path
