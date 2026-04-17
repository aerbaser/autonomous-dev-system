import type { ProjectState } from "../state/project-state.js";
import type { Config } from "../utils/config.js";
import { runOptimizer } from "../self-improve/optimizer.js";
import { generateDashboard } from "../dashboard/generate.js";
import { NIGHTLY_ENV_FLAG } from "../runtime/codex-preflight.js";

export type NightlyStepName = "optimize" | "dashboard";
export type NightlyStepStatus = "passed" | "failed" | "skipped";

export interface NightlyStepResult {
  name: NightlyStepName;
  status: NightlyStepStatus;
  detail: string;
}

export interface NightlyRunOptions {
  maxIterations?: number;
  skipOptimize?: boolean;
  skipDashboard?: boolean;
}

export interface NightlyRunResult {
  status: NightlyStepStatus;
  steps: NightlyStepResult[];
  dashboardPath?: string;
}

export async function runNightlyMaintenance(
  state: ProjectState,
  config: Config,
  options: NightlyRunOptions = {},
): Promise<NightlyRunResult> {
  // Phase 10: mark the process as a nightly run so any downstream code that
  // uses `isNightlyRun()` (e.g. orchestrator startup) knows inline prompt
  // mutation is allowed. Live runs never set this flag.
  process.env[NIGHTLY_ENV_FLAG] = "1";

  if (options.skipOptimize && options.skipDashboard) {
    return {
      status: "skipped",
      steps: [
        { name: "optimize", status: "skipped", detail: "Optimization skipped by option." },
        { name: "dashboard", status: "skipped", detail: "Dashboard generation skipped by option." },
      ],
    };
  }

  const steps: NightlyStepResult[] = [];
  const dashboardPath = `${config.stateDir}/dashboard.html`;

  if (options.skipOptimize) {
    steps.push({
      name: "optimize",
      status: "skipped",
      detail: "Optimization skipped by option.",
    });
  } else if (!config.selfImprove.enabled) {
    steps.push({
      name: "optimize",
      status: "skipped",
      detail: "Self-improvement is disabled in config.",
    });
  } else if (!config.selfImprove.nightlyOptimize) {
    steps.push({
      name: "optimize",
      status: "skipped",
      detail: "Nightly optimization is disabled in config.",
    });
  } else {
    try {
      await runOptimizer(state, config, {
        maxIterations: options.maxIterations ?? config.selfImprove.maxIterations,
      });
      steps.push({
        name: "optimize",
        status: "passed",
        detail: "Nightly optimization completed.",
      });
    } catch (err) {
      steps.push({
        name: "optimize",
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (options.skipDashboard) {
    steps.push({
      name: "dashboard",
      status: "skipped",
      detail: "Dashboard generation skipped by option.",
    });
  } else {
    try {
      await generateDashboard(config.stateDir, dashboardPath);
      steps.push({
        name: "dashboard",
        status: "passed",
        detail: `Dashboard generated at ${dashboardPath}.`,
      });
    } catch (err) {
      steps.push({
        name: "dashboard",
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyPassed = steps.some((step) => step.status === "passed");
  const anyFailed = steps.some((step) => step.status === "failed");

  return {
    status: anyFailed ? "failed" : anyPassed ? "passed" : "skipped",
    steps,
    ...(steps.some((step) => step.name === "dashboard" && step.status === "passed")
      ? { dashboardPath }
      : {}),
  };
}
