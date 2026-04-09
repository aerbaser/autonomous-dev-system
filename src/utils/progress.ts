import { EventEmitter } from "node:events";
import type { Phase } from "../state/project-state.js";

// ─── ANSI color helpers (no external deps) ───────────────────────────────────
// Disable colors when NO_COLOR is set or output is not a TTY.

const USE_COLOR =
  process.env["NO_COLOR"] === undefined && process.stdout.isTTY !== false;

const C = USE_COLOR
  ? {
      reset:  "\x1b[0m",
      bold:   "\x1b[1m",
      dim:    "\x1b[2m",
      red:    "\x1b[31m",
      green:  "\x1b[32m",
      yellow: "\x1b[33m",
      cyan:   "\x1b[36m",
      gray:   "\x1b[90m",
    }
  : {
      reset: "", bold: "", dim: "", red: "", green: "", yellow: "", cyan: "", gray: "",
    };

// ─── Human-readable phase labels ─────────────────────────────────────────────

const PHASE_LABELS: Partial<Record<Phase, string>> = {
  ideation:            "Ideation",
  specification:       "Specification",
  architecture:        "Architecture",
  "environment-setup": "Environment Setup",
  development:         "Development",
  testing:             "Testing",
  review:              "Code Review",
  staging:             "Staging Deploy",
  "ab-testing":        "A/B Testing",
  analysis:            "Analysis",
  production:          "Production Deploy",
  monitoring:          "Monitoring",
};

/** Returns a human-readable label for a phase slug. */
export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase] ?? phase;
}

// ─── Inline progress bar ─────────────────────────────────────────────────────

function progressBar(current: number, total: number, width = 20): string {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const empty  = width - filled;
  return (
    "\u2588".repeat(filled) +
    "\u2591".repeat(empty) +
    `  ${Math.round(pct * 100)}%`
  );
}

// ─── Event definitions ────────────────────────────────────────────────────────

export interface ProgressEvents {
  "phase:start": { phase: Phase; index: number; total: number };
  /** costUsd is optional — orchestrator may not include it in this event. */
  "phase:end":   { phase: Phase; success: boolean; elapsed: number; costUsd?: number };
  "batch:start": { index: number; total: number; taskCount: number };
  "batch:end":   { index: number; success: boolean };
  "shutdown":    { phase: Phase };
}

type EventName = keyof ProgressEvents;

// ─── Core emitter ─────────────────────────────────────────────────────────────

class ProgressEmitter {
  private emitter = new EventEmitter();

  emit<K extends EventName>(event: K, data: ProgressEvents[K]): void {
    this.emitter.emit(event, data);
  }

  on<K extends EventName>(event: K, listener: (data: ProgressEvents[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends EventName>(event: K, listener: (data: ProgressEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

export const progress = new ProgressEmitter();

// ─── ProgressDisplay: formatted console output ────────────────────────────────

interface PhaseRecord {
  phase: Phase;
  label: string;
  success: boolean;
  elapsedMs: number;
  costUsd?: number;
}

class ProgressDisplay {
  private _active    = false;
  private _verbose   = false;
  private _startMs   = 0;
  private _completed: PhaseRecord[] = [];

  /**
   * Install event listeners and start tracking run progress.
   * Idempotent — safe to call once per process.
   */
  enable(verbose = false): void {
    if (this._active) return;
    this._active  = true;
    this._verbose = verbose;
    this._startMs = Date.now();
    this._completed = [];

    progress.on("phase:start", (d) => { this._onPhaseStart(d); });
    progress.on("phase:end",   (d) => { this._onPhaseEnd(d); });
    progress.on("shutdown",    (d) => { this._onShutdown(d); });
  }

  private _onPhaseStart({ phase, index, total }: ProgressEvents["phase:start"]): void {
    const label  = phaseLabel(phase);
    const bar    = progressBar(index, total);
    const header = `[${index + 1}/${total}] ${label}`;
    console.log(
      `\n${C.bold}${C.cyan}┌─ ${header}${C.reset}`
    );
    console.log(`${C.gray}│  ${bar}${C.reset}`);
    if (this._verbose) {
      const runSec = ((Date.now() - this._startMs) / 1000).toFixed(1);
      console.log(`${C.gray}│  run time so far: ${runSec}s${C.reset}`);
    }
  }

  private _onPhaseEnd({ phase, success, elapsed, costUsd }: ProgressEvents["phase:end"]): void {
    const label    = phaseLabel(phase);
    const secs     = (elapsed / 1000).toFixed(1);
    const icon     = success ? `${C.green}✓` : `${C.red}✗`;
    const status   = success ? `${C.green}done` : `${C.red}failed`;
    const costPart = costUsd !== undefined
      ? `  ${C.dim}$${costUsd.toFixed(3)}${C.reset}`
      : "";
    console.log(
      `${C.gray}└─${C.reset} ${icon} ${status}${C.reset}` +
      `  ${C.dim}${label}: ${secs}s${C.reset}${costPart}`
    );
    const record: PhaseRecord = { phase, label, success, elapsedMs: elapsed };
    if (costUsd !== undefined) record.costUsd = costUsd;
    this._completed.push(record);
  }

  private _onShutdown({ phase }: ProgressEvents["shutdown"]): void {
    console.log(`\n${C.yellow}⚠  Interrupted at: ${phaseLabel(phase)}${C.reset}`);
    console.log(`${C.dim}   State saved. Resume with --resume.${C.reset}`);
  }

  /** Print a formatted run summary. Call after runOrchestrator() returns. */
  printSummary(finalPhase: Phase): void {
    if (!this._active) return;

    const totalMs   = Date.now() - this._startMs;
    const totalSec  = (totalMs / 1000).toFixed(1);
    const totalMin  = (totalMs / 60_000).toFixed(1);
    const timeStr   = totalMs >= 60_000 ? `${totalMin}m` : `${totalSec}s`;
    const done      = this._completed.filter((p) => p.success).length;
    const failed    = this._completed.filter((p) => !p.success).length;
    const totalCost = this._completed.reduce((s, p) => s + (p.costUsd ?? 0), 0);

    const W  = 46;
    const hr = "─".repeat(W);

    const row = (text: string): void => {
      const pad = W - text.length;
      console.log(`${C.cyan}│${text}${" ".repeat(Math.max(0, pad))}│${C.reset}`);
    };

    console.log(`\n${C.bold}${C.cyan}┌${hr}┐`);
    row("  Run Complete");
    console.log(`├${hr}┤${C.reset}`);

    if (this._completed.length > 0) {
      for (const rec of this._completed) {
        const s    = (rec.elapsedMs / 1000).toFixed(1);
        const icon = rec.success ? `${C.green}✓${C.cyan}` : `${C.red}✗${C.cyan}`;
        const cost = rec.costUsd !== undefined ? `  $${rec.costUsd.toFixed(3)}` : "";
        const line = `  ${icon} ${rec.label.padEnd(24)}${s.padStart(5)}s${cost}`;
        row(line);
      }
      console.log(`${C.cyan}├${hr}┤${C.reset}`);
    }

    row(`  Phases : ${done} done${failed > 0 ? `, ${failed} failed` : ""}`);
    row(`  Time   : ${timeStr}`);
    if (totalCost > 0) {
      row(`  Cost   : $${totalCost.toFixed(3)}`);
    }
    row(`  Final  : ${phaseLabel(finalPhase)}`);
    console.log(`${C.cyan}└${hr}┘${C.reset}\n`);
  }
}

export const display = new ProgressDisplay();
