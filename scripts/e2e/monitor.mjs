#!/usr/bin/env node
// Live monitor for an autonomous-dev-system run.
// Tails .autonomous-dev/events/*.jsonl and prints per-phase / per-agent /
// per-model cost, token usage, cache-hit rate, and turn utilization.
//
// Usage:
//   node scripts/e2e/monitor.mjs [path/to/.autonomous-dev]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const STATE_DIR = resolve(process.argv[2] ?? ".autonomous-dev");
const EVENTS_DIR = resolve(STATE_DIR, "events");
const STATE_FILE = resolve(STATE_DIR, "state.json");
const REFRESH_MS = 10_000;

function parseJsonl(path) {
  try {
    return readFileSync(path, "utf-8")
      .split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readAllEvents() {
  if (!existsSync(EVENTS_DIR)) return [];
  return readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => parseJsonl(resolve(EVENTS_DIR, f)));
}

function fmtUsd(n) {
  if (n === 0) return "$0.0000";
  if (n < 0.001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}
function fmtTok(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function pct(n) { return `${(n * 100).toFixed(0)}%`; }

function aggregate(events) {
  const byPhase = new Map();
  const byAgent = new Map();
  const byModel = new Map();
  let totalCost = 0;
  let currentPhase = null;
  let phaseCount = 0;
  let rubricRetries = 0;

  for (const ev of events) {
    const d = ev.data ?? ev;

    if (ev.type === "orchestrator.phase.start") {
      currentPhase = d.phase;
      phaseCount += 1;
    }

    if (ev.type === "evaluation.rubric.start" && d.iteration > 1) {
      rubricRetries += 1;
    }

    if (ev.type === "agent.query.end") {
      const phase = d.phase ?? "unknown";
      const agent = d.agentName ?? "unknown";
      const cost = Number(d.costUsd ?? 0);
      const inTok = Number(d.inputTokens ?? 0);
      const outTok = Number(d.outputTokens ?? 0);
      const cacheRead = Number(d.cacheReadInputTokens ?? 0);
      const cacheCreate = Number(d.cacheCreationInputTokens ?? 0);

      totalCost += cost;

      const p = byPhase.get(phase) ?? { cost: 0, calls: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheCreate: 0 };
      p.cost += cost; p.calls += 1; p.inTok += inTok; p.outTok += outTok;
      p.cacheRead += cacheRead; p.cacheCreate += cacheCreate;
      byPhase.set(phase, p);

      const a = byAgent.get(agent) ?? { cost: 0, calls: 0, inTok: 0, outTok: 0, cacheRead: 0 };
      a.cost += cost; a.calls += 1; a.inTok += inTok; a.outTok += outTok; a.cacheRead += cacheRead;
      byAgent.set(agent, a);

      // Per-model breakdown from modelUsage
      const mu = d.modelUsage;
      if (mu && typeof mu === "object") {
        for (const [model, usage] of Object.entries(mu)) {
          const m = byModel.get(model) ?? { cost: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheCreate: 0 };
          m.cost += Number(usage.costUSD ?? 0);
          m.inTok += Number(usage.inputTokens ?? 0);
          m.outTok += Number(usage.outputTokens ?? 0);
          m.cacheRead += Number(usage.cacheReadInputTokens ?? 0);
          m.cacheCreate += Number(usage.cacheCreationInputTokens ?? 0);
          byModel.set(model, m);
        }
      }
    }
  }

  return { byPhase, byAgent, byModel, totalCost, currentPhase, phaseCount, rubricRetries, eventCount: events.length };
}

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { return null; }
}

function print(snap) {
  console.clear();
  const now = new Date().toISOString();
  console.log(`═══ e2e monitor @ ${now} ═══`);
  const state = readState();
  if (state) {
    console.log(`project: ${state.projectId?.slice(0, 8) ?? "?"}  phase: ${state.currentPhase ?? "?"}  tasks: ${state.tasks?.length ?? 0}  agents: ${Object.keys(state.agents ?? {}).length}  checkpoints: ${state.checkpoints?.length ?? 0}`);
  }
  console.log(`events: ${snap.eventCount}  phases-started: ${snap.phaseCount}  rubric-retries: ${snap.rubricRetries}  total-cost: ${fmtUsd(snap.totalCost)}`);

  console.log(`\n── by phase ──`);
  const phases = [...snap.byPhase.entries()].sort((a, b) => b[1].cost - a[1].cost);
  console.log("phase                cost       calls  input    output   cacheR   cacheC   hit%");
  for (const [phase, p] of phases) {
    const totalIn = p.inTok + p.cacheRead;
    const hit = totalIn > 0 ? pct(p.cacheRead / totalIn) : "n/a";
    console.log(`${phase.padEnd(20)} ${fmtUsd(p.cost).padStart(9)}  ${String(p.calls).padStart(4)}   ${fmtTok(p.inTok).padStart(6)}  ${fmtTok(p.outTok).padStart(6)}   ${fmtTok(p.cacheRead).padStart(6)}   ${fmtTok(p.cacheCreate).padStart(6)}   ${hit.padStart(4)}`);
  }

  console.log(`\n── by model ──`);
  const models = [...snap.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  console.log("model                          cost       input    output   cacheR   hit%");
  for (const [model, m] of models) {
    const totalIn = m.inTok + m.cacheRead;
    const hit = totalIn > 0 ? pct(m.cacheRead / totalIn) : "n/a";
    console.log(`${model.padEnd(30)} ${fmtUsd(m.cost).padStart(9)}  ${fmtTok(m.inTok).padStart(6)}  ${fmtTok(m.outTok).padStart(6)}   ${fmtTok(m.cacheRead).padStart(6)}   ${hit.padStart(4)}`);
  }

  console.log(`\n── by agent (top 15) ──`);
  const agents = [...snap.byAgent.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15);
  console.log("agent                    cost       calls  input    output   cacheR");
  for (const [agent, a] of agents) {
    console.log(`${agent.padEnd(24)} ${fmtUsd(a.cost).padStart(9)}  ${String(a.calls).padStart(4)}   ${fmtTok(a.inTok).padStart(6)}  ${fmtTok(a.outTok).padStart(6)}   ${fmtTok(a.cacheRead).padStart(6)}`);
  }

  console.log(`\n(refresh every ${REFRESH_MS / 1000}s, Ctrl+C to stop)`);
}

function loop() {
  try { print(aggregate(readAllEvents())); }
  catch (err) { console.error("[monitor] error:", err.message); }
}

loop();
setInterval(loop, REFRESH_MS);
