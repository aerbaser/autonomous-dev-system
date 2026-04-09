import type { DashboardData, PhaseStats, EvolutionRow, AgentInfo, PhaseEvent } from "./generate.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso;
  }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour12: false, timeStyle: "short" })
    );
  } catch {
    return iso;
  }
}

function elapsed(createdAt: string): string {
  try {
    const ms = Date.now() - new Date(createdAt).getTime();
    const s = Math.floor(ms / 1_000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  } catch {
    return "—";
  }
}

function phaseShortLabel(phase: string): string {
  const labels: Record<string, string> = {
    "ideation": "Ideation",
    "specification": "Spec",
    "architecture": "Arch",
    "environment-setup": "Env Setup",
    "development": "Dev",
    "testing": "Testing",
    "review": "Review",
    "staging": "Staging",
    "ab-testing": "A/B",
    "analysis": "Analysis",
    "production": "Production",
    "monitoring": "Monitor",
  };
  return labels[phase] ?? phase;
}

function eventKind(type: string): string {
  if (type.includes("phase.start")) return "phase-start";
  if (type.includes("phase.end")) return "phase-end";
  if (type.toLowerCase().includes("error")) return "error";
  if (type.includes("agent")) return "agent";
  return "info";
}

// ── Section renderers ─────────────────────────────────────────────────────

function renderPipeline(phases: PhaseStats[]): string {
  const items = phases
    .map((p, i) => {
      const dot =
        p.status === "completed"
          ? `<div class="phase-dot done">✓</div>`
          : p.status === "current"
          ? `<div class="phase-dot current">◉</div>`
          : `<div class="phase-dot pending">○</div>`;
      const meta =
        p.status === "completed" && (p.durationMs !== undefined || p.costUsd !== undefined)
          ? `<div class="phase-meta">${p.durationMs !== undefined ? fmtMs(p.durationMs) : ""}${p.costUsd !== undefined ? ` · ${fmtCost(p.costUsd)}` : ""}</div>`
          : "";
      const connector = i < phases.length - 1 ? `<div class="phase-conn"></div>` : "";
      return `<div class="phase-item phase-${p.status}">${dot}<div class="phase-name">${esc(phaseShortLabel(p.phase))}</div>${meta}</div>${connector}`;
    })
    .join("");
  return `<div class="pipeline">${items}</div>`;
}

function renderCostChart(phases: PhaseStats[]): string {
  const withCost = phases.filter((p): p is PhaseStats & { costUsd: number } => (p.costUsd ?? 0) > 0);
  if (withCost.length === 0) {
    return `<div class="empty">No cost data yet</div>`;
  }
  const maxCost = Math.max(...withCost.map((p) => p.costUsd));
  return `<div class="bar-chart">${withCost
    .map((p) => {
      const pct = maxCost > 0 ? ((p.costUsd / maxCost) * 100).toFixed(1) : "0";
      return `<div class="bar-row">
        <div class="bar-label">${esc(phaseShortLabel(p.phase))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-value">${fmtCost(p.costUsd)}</div>
      </div>`;
    })
    .join("")}</div>`;
}

function renderEvolution(evolution: EvolutionRow[]): string {
  if (evolution.length === 0) {
    return `<div class="empty">No evolution entries yet</div>`;
  }

  const last5 = evolution.slice(-5);
  const avgDelta =
    last5.reduce((sum, e) => sum + (e.scoreAfter - e.scoreBefore), 0) / last5.length;
  const acceptedCount = last5.filter((e) => e.accepted).length;
  let trendLabel: string;
  let trendCls: string;
  if (avgDelta > 0.05) {
    trendLabel = "improving ▲";
    trendCls = "pos";
  } else if (avgDelta < -0.05) {
    trendLabel = "degrading ▼";
    trendCls = "neg";
  } else {
    trendLabel = "plateaued ─";
    trendCls = "muted";
  }

  const rows = [...evolution]
    .reverse()
    .slice(0, 20)
    .map((e) => {
      const delta = e.scoreAfter - e.scoreBefore;
      const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
      const deltaCls = delta > 0 ? "pos" : delta < 0 ? "neg" : "muted";
      const badge = e.accepted
        ? `<span class="badge badge-g">✓</span>`
        : `<span class="badge badge-r">✗</span>`;
      return `<tr>
        <td class="mono muted">${esc(e.target.slice(0, 18))}</td>
        <td class="mono muted">${esc(e.type.replace(/_/g, " "))}</td>
        <td class="mono">${e.scoreBefore.toFixed(2)}</td>
        <td class="mono">${e.scoreAfter.toFixed(2)}</td>
        <td class="mono ${deltaCls}">${deltaStr}</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");

  return `<div class="trend-bar">
    Trend (last 5): <span class="mono ${trendCls}">${trendLabel}</span>
    &nbsp;·&nbsp; Accepted: ${acceptedCount}/${last5.length}
  </div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Target</th><th>Type</th><th>Before</th><th>After</th><th>Δ</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderAgents(agents: AgentInfo[]): string {
  if (agents.length === 0) {
    return `<div class="empty">No agents registered yet</div>`;
  }
  return `<div class="agent-grid">${agents
    .map(
      (a) => `<div class="agent-card">
      <div class="agent-name">${esc(a.name)}</div>
      <div class="agent-role">${esc(a.role)}</div>
      ${a.domain !== undefined ? `<div class="agent-domain">${esc(a.domain)}</div>` : ""}
      <div class="agent-prompt">${esc(a.systemPromptExcerpt)}…</div>
    </div>`
    )
    .join("")}</div>`;
}

function renderTimeline(events: PhaseEvent[]): string {
  if (events.length === 0) {
    return `<div class="empty">No events yet</div>`;
  }
  const items = [...events]
    .reverse()
    .slice(0, 60)
    .map((ev) => {
      const kind = eventKind(ev.type);
      const phase =
        typeof ev.data["phase"] === "string" ? esc(ev.data["phase"] as string) : "";
      const cost =
        typeof ev.data["costUsd"] === "number"
          ? ` · ${fmtCost(ev.data["costUsd"] as number)}`
          : "";
      const dur =
        typeof ev.data["durationMs"] === "number"
          ? ` · ${fmtMs(ev.data["durationMs"] as number)}`
          : "";
      const detail = phase ? `<div class="ev-detail"><span class="ev-ph">${phase}${cost}${dur}</span></div>` : "";
      return `<div class="ev ev-${kind}">
        <span class="ev-time">${fmtTime(ev.timestamp)}</span>
        <div class="ev-type">${esc(ev.type)}</div>
        ${detail}
      </div>`;
    })
    .join("");
  return `<div class="timeline">${items}</div>`;
}

// ── Main render ────────────────────────────────────────────────────────────

export function renderDashboard(data: DashboardData): string {
  const completedCount = data.phases.filter((p) => p.status === "completed").length;
  const totalPhases = data.phases.length;
  const progress = Math.round((completedCount / totalPhases) * 100);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Autonomous Dev — Dashboard</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0d1117;--card:#161b22;--el:#21262d;--bd:#30363d;
      --tx:#e6edf3;--mt:#8b949e;--dm:#484f58;
      --gr:#3fb950;--bl:#58a6ff;--rd:#f85149;
      --yw:#d29922;--pu:#bc8cff;
    }
    html,body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;min-height:100vh}
    .wrap{max-width:1400px;margin:0 auto;padding:16px}
    /* header */
    .hdr{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px 20px;margin-bottom:12px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .hdr-l{flex:1;min-width:0}
    .hdr-tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--mt);margin-bottom:6px}
    .hdr-idea{font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
    .hdr-id{font-family:"SF Mono","Fira Code",monospace;font-size:11px;color:var(--mt)}
    .hdr-r{display:flex;gap:24px;flex-shrink:0}
    .stat{text-align:right}
    .stat-lbl{font-size:11px;color:var(--mt);text-transform:uppercase;letter-spacing:.4px}
    .stat-val{font-size:20px;font-weight:700;font-family:"SF Mono","Fira Code",monospace}
    .stat-val.gr{color:var(--gr)}.stat-val.bl{color:var(--bl)}
    .prog-outer{background:var(--el);border-radius:4px;height:4px;width:120px;margin-top:4px}
    .prog-inner{height:4px;border-radius:4px;background:var(--gr)}
    .gen-ts{font-size:10px;color:var(--dm);margin-top:4px}
    /* cards */
    .card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;overflow:hidden}
    .ctitle{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.7px;color:var(--mt);margin-bottom:12px;display:flex;align-items:center;gap:8px}
    .ctitle::before{content:"";display:block;width:3px;height:12px;border-radius:2px;background:var(--bl)}
    .ph-sec{margin-bottom:12px}
    .g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
    @media(max-width:860px){.g2{grid-template-columns:1fr}}
    /* pipeline */
    .pipeline{display:flex;align-items:flex-start;overflow-x:auto;padding:4px 0;scrollbar-width:thin}
    .phase-item{display:flex;flex-direction:column;align-items:center;min-width:72px;flex:1}
    .phase-conn{flex:0 0 12px;height:22px;display:flex;align-items:center}
    .phase-conn::before{content:"";display:block;width:100%;height:2px;background:var(--bd)}
    .phase-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-bottom:5px;flex-shrink:0}
    .phase-completed .phase-dot.done{background:var(--gr);color:#0d1117}
    .phase-current .phase-dot.current{background:var(--bl);color:#0d1117;box-shadow:0 0 0 3px rgba(88,166,255,.25);animation:pulse 2s infinite}
    .phase-pending .phase-dot.pending{background:var(--el);border:2px solid var(--bd);color:var(--dm)}
    @keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(88,166,255,.25)}50%{box-shadow:0 0 0 7px rgba(88,166,255,.08)}}
    .phase-name{font-size:10px;text-align:center;color:var(--mt);line-height:1.3}
    .phase-current .phase-name{color:var(--bl);font-weight:600}
    .phase-completed .phase-name{color:var(--tx)}
    .phase-meta{font-size:9px;color:var(--dm);text-align:center;margin-top:2px;font-family:"SF Mono","Fira Code",monospace}
    /* bars */
    .bar-chart{display:flex;flex-direction:column;gap:7px}
    .bar-row{display:flex;align-items:center;gap:8px}
    .bar-label{width:75px;font-size:11px;color:var(--mt);flex-shrink:0;text-align:right}
    .bar-track{flex:1;background:var(--el);border-radius:3px;height:15px;overflow:hidden}
    .bar-fill{height:100%;background:linear-gradient(90deg,var(--bl),var(--pu));border-radius:3px;min-width:2px;transition:width .4s}
    .bar-value{width:58px;font-size:11px;font-family:"SF Mono","Fira Code",monospace;color:var(--mt);flex-shrink:0}
    /* evolution */
    .trend-bar{font-size:12px;color:var(--mt);margin-bottom:10px}
    .tbl-wrap{overflow-x:auto}
    .tbl{width:100%;border-collapse:collapse;font-size:12px}
    .tbl th{text-align:left;color:var(--mt);font-weight:500;font-size:11px;padding:5px 7px;border-bottom:1px solid var(--bd)}
    .tbl td{padding:4px 7px;border-bottom:1px solid var(--el);vertical-align:middle}
    .tbl tr:last-child td{border-bottom:none}
    .tbl tr:hover td{background:var(--el)}
    /* agents */
    .agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;max-height:320px;overflow-y:auto}
    .agent-card{background:var(--el);border:1px solid var(--bd);border-radius:6px;padding:10px}
    .agent-name{font-size:12px;font-weight:600;color:var(--pu);margin-bottom:2px;font-family:"SF Mono","Fira Code",monospace}
    .agent-role{font-size:11px;color:var(--tx);margin-bottom:2px}
    .agent-domain{font-size:10px;color:var(--yw);margin-bottom:4px}
    .agent-prompt{font-size:10px;color:var(--dm);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    /* timeline */
    .timeline{max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
    .ev{padding:5px 8px;border-radius:4px;border-left:3px solid var(--bd);background:var(--el);position:relative}
    .ev-phase-start{border-left-color:var(--bl)}
    .ev-phase-end{border-left-color:var(--gr)}
    .ev-error{border-left-color:var(--rd);background:rgba(248,81,73,.07)}
    .ev-agent{border-left-color:var(--pu)}
    .ev-time{font-size:10px;color:var(--dm);font-family:"SF Mono","Fira Code",monospace;float:right;margin-left:8px}
    .ev-type{font-size:11px;color:var(--mt);font-family:"SF Mono","Fira Code",monospace}
    .ev-detail{font-size:11px;color:var(--mt);margin-top:2px}
    .ev-ph{color:var(--bl)}
    /* utils */
    .empty{color:var(--dm);font-size:12px;text-align:center;padding:20px 0}
    .mono{font-family:"SF Mono","Fira Code",monospace}
    .muted{color:var(--mt)}
    .pos{color:var(--gr)}
    .neg{color:var(--rd)}
    .badge{font-size:10px;padding:2px 5px;border-radius:8px;font-weight:600}
    .badge-g{background:rgba(63,185,80,.15);color:var(--gr)}
    .badge-r{background:rgba(248,81,73,.15);color:var(--rd)}
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--el);border-radius:3px}
    ::-webkit-scrollbar-thumb:hover{background:var(--bd)}
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="hdr">
    <div class="hdr-l">
      <div class="hdr-tag">Autonomous Dev System · Monitoring Dashboard</div>
      <div class="hdr-idea">${esc(data.idea)}</div>
      <div class="hdr-id">${esc(data.projectId)}</div>
    </div>
    <div class="hdr-r">
      <div class="stat">
        <div class="stat-lbl">Phase</div>
        <div class="stat-val bl">${esc(data.currentPhase)}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl">Total Cost</div>
        <div class="stat-val">${fmtCost(data.totalCostUsd)}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl">Progress</div>
        <div class="stat-val gr">${completedCount}/${totalPhases}</div>
        <div class="prog-outer"><div class="prog-inner" style="width:${progress}%"></div></div>
      </div>
      <div class="stat">
        <div class="stat-lbl">Elapsed</div>
        <div class="stat-val">${elapsed(data.createdAt)}</div>
        <div class="gen-ts">Generated ${fmtDateTime(data.generatedAt)}</div>
      </div>
    </div>
  </div>

  <!-- Phase Pipeline -->
  <div class="ph-sec card">
    <div class="ctitle">Phase Pipeline</div>
    ${renderPipeline(data.phases)}
  </div>

  <!-- Cost + Evolution -->
  <div class="g2">
    <div class="card">
      <div class="ctitle">Cost per Phase</div>
      ${renderCostChart(data.phases)}
    </div>
    <div class="card">
      <div class="ctitle">Self-Improvement Metrics</div>
      ${renderEvolution(data.evolution)}
    </div>
  </div>

  <!-- Agents + Timeline -->
  <div class="g2">
    <div class="card">
      <div class="ctitle">Agent Registry (${data.agents.length})</div>
      ${renderAgents(data.agents)}
    </div>
    <div class="card">
      <div class="ctitle">Event Timeline (${data.events.length} events)</div>
      ${renderTimeline(data.events)}
    </div>
  </div>

</div>
</body>
</html>`;
}
