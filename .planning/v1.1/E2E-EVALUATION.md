# v1.1 E2E Evaluation Protocol

**Purpose:** after running the first real E2E on a live toy idea with `AUTONOMOUS_DEV_LEAD_DRIVEN=1`, use this doc as a checklist to (a) confirm super-lead delivered real value and (b) decide whether the three deferred v1.2 items need to be actually built.

## How to run

```bash
# Choose a scratch project dir outside the repo
mkdir -p /tmp/ads-e2e-$(date +%s) && cd /tmp/ads-e2e-$(date +%s)

# Live run with lead-driven phases + a sane budget
AUTONOMOUS_DEV_LEAD_DRIVEN=1 \
  /Users/admin/Desktop/AI/Web2/autonomous-dev-system/dist/index.js \
  run --idea "<your idea>" --budget 10.00
```

Auth is inherited from the Claude Code subscription — no `ANTHROPIC_API_KEY` needed.

## Artifacts to inspect after the run

All paths relative to the project's `.autonomous-dev/` directory.

- `state.json` — final project state, includes `phaseAttempts[]` (append-only) and `backloopCounts` (per-pair counter)
- `ledger/{runId}.json` — per-session spend and topology; look for `sessionType: "team_lead"` entries on migrated phases
- `events/{runId}.jsonl` — full EventBus timeline; `agent.query.start` and `agent.query.end` pairs show when specialists were delegated
- `events/{runId}.summary.json` — aggregated run summary
- `receipts/{runId}/*.json` — per-task receipts from development
- `dashboard.html` — visual overview (phases + costs + agents + evolution)

## Quick-look commands

```bash
# How many attempts per phase (should be >1 for backloopped phases)
jq '.phaseAttempts | to_entries | map({phase:.key, attempts:.value|length})' \
   .autonomous-dev/state.json

# Backloop counter (non-empty means the pipeline iterated)
jq '.backloopCounts' .autonomous-dev/state.json

# Which phases used the lead-driven path (look for team_lead sessionType)
jq '.sessions | map(select(.role == "team_lead")) | map({phase, costUsd: .spend.costUsd, durationMs})' \
   .autonomous-dev/ledger/*.json

# Total run cost
jq '.totalCostUsd' .autonomous-dev/state.json

# Specialist invocations — children of a team_lead session
jq '.sessions | map(select(.parentSessionId != null)) | map({phase, role, agentName, costUsd: .spend.costUsd})' \
   .autonomous-dev/ledger/*.json
```

## Pass/fail criteria for the E2E itself

1. All 12 phases complete OR the run stops cleanly via livelock guard (neither a crash nor an infinite loop)
2. `state.phaseAttempts["architecture"]` has exactly 1 entry with `success=true`
3. Ledger shows `sessionType: "team_lead"` entries for at least architecture, review, testing (specification only if ideation finished)
4. At least one specialist session with a non-null `parentSessionId` exists — proves Agent-tool delegation actually happened (not just the lead doing everything itself)
5. `totalCostUsd` is within the `--budget` cap
6. Dashboard renders without errors
7. No Zod validation errors in stderr
8. SIGINT during the run produces a clean exit (can be tested by Ctrl-C'ing one attempt and resuming with `--resume <sessionId>`)

If any of (1)-(7) fails, fix before evaluating super-lead value — we're measuring the wrong thing if the plumbing is broken.

## Triggers for the three deferred v1.2 items

Each deferred item has a concrete, observable trigger in the E2E artifacts. If a trigger fires, start a v1.2 plan. If no trigger fires, the deferral was correct.

### 1. `ideation` migration to lead-driven

**Why deferred:** ideation has a custom parallel `analyzeDomain + spec-generation` flow (Promise.allSettled). The current primitive is single-query. Migrating = either serializing (slower) or extending the primitive with parallel sub-leads. Also, there are no obvious specialists that add value at ideation time — `out-of-scope-guard` filters stories, it doesn't help generate them.

**Trigger A — user stories miss intent:**
- Inspect `state.spec.userStories` — are the stories a faithful decomposition of the idea prompt, or did the PM-agent hallucinate features?
- If ≥2 stories are scope creep OR ≥1 core story from the idea is missing → trigger fires.

**Trigger B — specification phase keeps rewriting ideation output:**
- Compare `state.spec.userStories` (from ideation) against `state.spec.detailed.refinedUserStories` (from specification).
- If specification had to significantly rewrite (not just refine AC) more than 30% of stories → ideation output was weak.

**Trigger C — ledger shows ideation cost dominates:**
- If ideation's cost is >15% of total run cost, the single-query prompt is doing too much work and would benefit from specialist delegation.

**If any trigger fires:** plan `v1.2-ideation-migration` — decide whether to serialize the analyzeDomain+spec flow into the primitive OR extend the primitive for parallel sub-leads.

### 2. `development-runner` unification through the new primitive

**Why deferred:** dev-runner already uses the agent-team pattern — it was the source of the primitive. Unifying is pure code-consolidation (two implementations → one), zero behavior change.

**Trigger A — divergence bug:**
- After the E2E run, grep `src/phases/development-runner.ts` vs `src/orchestrator/lead-driven-phase.ts` for invariants we added to the primitive that are NOT mirrored in dev-runner. Today: `sanitizeSpecialistTools`, `parseLeadEnvelope`, `PhaseBudgetGuard`.
- If dev-runner is missing any of the three → trigger fires.

**Trigger B — we need to change the primitive:**
- If during v1.2 we add parallel sub-leads OR cross-phase session chaining, the primitive changes shape. At that point dev-runner should be unified so it inherits the change.

**Trigger C — maintenance cost:**
- If a bug in one of the two implementations ships and has to be fixed in both → trigger fires.

**If any trigger fires:** plan `v1.2-devrunner-unify`. Replace dev-runner's inline `query()` call with `runLeadDrivenPhase({ contract: developmentContract, ... })` and keep the per-batch composition logic inside the `applyResult` mapper.

### 3. M1 — cross-phase meta-session (lead remembers across phases)

**Why deferred:** the design review found M1 breaks prompt caching (5-min TTL vs hours-long runs), balloons context linearly with phase depth, and complicates SIGINT resume across process restarts. M2 (per-phase session, facts carried via state.json) was shipped instead.

**Trigger A — "the lead forgot the rationale":**
- Look at each team_lead's first message in `events/{runId}.jsonl` — the lead prompt is a fresh slice of state.json.
- Read each phase's output (architecture → review → testing). Is there a case where a later phase's lead made a decision that **contradicts** or **ignores** a rationale explicitly stated in an earlier phase?
  - e.g. architecture chose Postgres "because strict transactional guarantees"; review then flagged a non-issue about MongoDB-style schema drift → the review lead didn't know why Postgres was chosen.
- If ≥1 clear contradiction of an earlier phase's rationale → trigger fires.

**Trigger B — state.json JSON is not enough:**
- Check `state.spec` and `state.architecture` — do they carry the *why* behind each decision? Or just the *what*?
- If you see important tradeoffs locked in the ProductSpec/ArchDesign but their rationale exists only in the lead's first-response reasoning (not in the state), M2 is lossy.
- Measure: pick 3 non-obvious architecture choices and check whether `state.architecture` explains *why*. If ≥2 are "unexplained in state", M1 would have value.

**Trigger C — backloop-driven context explosion:**
- If the E2E triggers 2+ backloops AND each re-entry of a phase produces a different decision despite identical state.json → lead is not converging because it lacks memory of *what it tried last time*.
- Check `state.phaseAttempts[phase][]`: if attempts diverge substantially (different architecture on 2nd attempt vs 1st despite same input) → trigger fires.

**If any trigger fires:** plan `v1.2-m1-session-resume` as a spike, NOT a full rollout. Prove on one phase pair first (e.g., architecture → review) before touching all 12. Include: SDK session-resume viability check, cache-TTL impact on real prompt sizes, SIGINT+process-restart recovery model.

## If nothing triggers

The E2E confirms the v1.1 design: per-phase agent teams with state.json as the cross-phase memory channel is sufficient for this problem class. The three deferred items were correct deferrals and can remain in backlog indefinitely.

Mark this doc with: `STATUS: E2E ran YYYY-MM-DD, no triggers fired, deferrals confirmed` and move on.

## If something triggers

Open a v1.2 phase via `/gsd-add-phase` or `/gsd-new-milestone`, copy the relevant trigger section + evidence into the phase PRD, and plan from there. Do NOT retrofit deferred items without concrete evidence from this doc.
