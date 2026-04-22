import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "./shared.js";

const selfImproveSchema = z.object({
  enabled: z.boolean().default(true),
  maxIterations: z.number().default(50),
  nightlyOptimize: z.boolean().default(false),
});

const maxTurnsSchema = z.object({
  default: z.number().default(50),
  decomposition: z.number().default(3),
  // development: lowered from 60 → 30 to discourage wasteful reasoning inside
  // a single batch. Most tasks finish in <20 turns; 30 leaves headroom without
  // inviting 60-turn loops on simple tasks.
  development: z.number().default(30),
  qualityFix: z.number().default(30),
  testing: z.number().default(30),
  review: z.number().default(20),
  deployment: z.number().default(20),
  monitoring: z.number().default(10),
  ideation: z.number().default(10),
  architecture: z.number().default(10),
  abTesting: z.number().default(10),
  stackResearch: z.number().default(15),
  domainAnalysis: z.number().default(5),
  ossScan: z.number().default(10),
  specification: z.number().default(10),
  analysis: z.number().default(10),
});

export const MAX_TURNS_DEFAULTS = {
  default: 50,
  decomposition: 3,
  development: 30,
  qualityFix: 30,
  testing: 30,
  review: 20,
  deployment: 20,
  monitoring: 10,
  ideation: 10,
  architecture: 10,
  abTesting: 10,
  stackResearch: 15,
  domainAnalysis: 5,
  ossScan: 10,
  specification: 10,
  analysis: 10,
} satisfies z.input<typeof maxTurnsSchema>;

const memoryLayersSchema = z.object({
  enabled: z.boolean().default(true),
});

const memorySchema = z.object({
  enabled: z.boolean().default(true),
  maxDocuments: z.number().default(500),
  maxDocumentSizeKb: z.number().default(100),
  captureModel: z.string().optional(),
  layers: memoryLayersSchema.default({ enabled: true }),
});

// Mid-phase user-clarification gate. Default OFF — the orchestrator runs fully
// autonomous and only journals questions to `{stateDir}/pending-questions.jsonl`
// when the flag is off. Flip on (via config override or CLI flag) to let
// phases prompt on a real TTY.
const interactiveSchema = z.object({
  allowAskUser: z.boolean().default(false),
});
export type InteractiveConfig = z.infer<typeof interactiveSchema>;

export const DEFAULT_INTERACTIVE = {
  allowAskUser: false,
} satisfies z.input<typeof interactiveSchema>;

const codexSubagentsSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default("gpt-5.4"),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("xhigh"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).default("on-request"),
  ephemeral: z.boolean().default(true),
  skipGitRepoCheck: z.boolean().default(true),
});

export const DEFAULT_CODEX_SUBAGENTS = {
  enabled: false,
  model: "gpt-5.4",
  reasoningEffort: "xhigh",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  ephemeral: true,
  skipGitRepoCheck: true,
} satisfies z.input<typeof codexSubagentsSchema>;

const deployTargetSchema = z.object({
  provider: z.enum(["vercel", "netlify", "docker", "custom"]),
  config: z.record(z.string(), z.string()).default({}),
});

// Phase 4: per-role spend ceilings & concurrency caps.
const roleBudgetSchema = z.object({
  budgetUsd: z.number().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
});
export type RoleBudget = z.infer<typeof roleBudgetSchema>;

// Phase 4: retry/escalation policy per failure class.
const retryPolicySchema = z.object({
  provider_limit: z
    .enum(["checkpoint", "downgrade", "stop"])
    .default("checkpoint"),
  verification_failed: z
    .object({ maxAttempts: z.number().int().min(1).default(2) })
    .default({ maxAttempts: 2 }),
  identical_failure_abort: z.boolean().default(true),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

// Phase 3: explicit opt-in for the legacy "lead developer" prompt wrapper that
// orchestrates subagent delegation. Default path dispatches each task directly
// to its subagent (no second coordination loop). Enable only when you need a
// supervising lead across heterogeneous subagents.
const developmentCoordinatorSchema = z.object({
  enabled: z.boolean().default(false),
});
export type DevelopmentCoordinatorConfig = z.infer<
  typeof developmentCoordinatorSchema
>;

// Phase 8: auxiliary-loop profile gating.
//   minimal — skip rubric, per-task memory capture, quality-fix retries.
//             Phase-end memory capture still runs so cross-run learnings
//             persist. This is the default (production) path.
//   debug   — all auxiliary loops on, verbose.
//   nightly — rubric+memory on, but no interactive observers.
const auxiliaryProfileSchema = z
  .enum(["minimal", "debug", "nightly"])
  .default("minimal");
export type AuxiliaryProfile = z.infer<typeof auxiliaryProfileSchema>;

/**
 * SEC-08 invariant — Anthropic API key must NOT live on this Config object.
 *
 * Do NOT add any of the following fields to ConfigSchema:
 *   - apiKey / anthropicApiKey / anthropic_api_key
 *   - ANTHROPIC_API_KEY (env-style name)
 *   - claudeApiKey / claude_api_key
 *
 * Rationale (PRODUCT.md §15 Security + REQUIREMENTS.md SEC-08):
 *   Anthropic authentication is handled either by (a) the Claude Code
 *   subscription path (transparent to this codebase — no env var required),
 *   or (b) `ANTHROPIC_API_KEY` read directly by the SDK from process.env.
 *   In neither case should our Config deserialize or retain the key —
 *   doing so risks (i) accidental logging via JSON.stringify(config), and
 *   (ii) accidental persistence to .autonomous-dev/state.json or similar.
 *
 * Only third-party PROVIDER tokens (PostHog, GitHub, Slack) are read from
 * env into Config, because those are used by OPTIONAL phases that need the
 * value in-process. Anthropic auth is never in that category.
 *
 * Regression: tests/utils/config.test.ts SEC-08 block pins this invariant.
 */
export const ConfigSchema = z.object({
  model: z
    .enum(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"])
    .default("claude-opus-4-6"),
  subagentModel: z
    .enum(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"])
    .default("claude-sonnet-4-6"),
  posthogApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  slackWebhookUrl: z.string().url().optional(),
  deployTarget: deployTargetSchema.optional(),
  selfImprove: selfImproveSchema.default({
    enabled: true,
    maxIterations: 50,
    nightlyOptimize: false,
  } satisfies z.input<typeof selfImproveSchema>),
  projectDir: z.string().default("."),
  stateDir: z.string().default(".autonomous-dev"),
  autonomousMode: z.boolean().default(true),
  maxTurns: maxTurnsSchema.default(MAX_TURNS_DEFAULTS),
  budgetUsd: z.number().positive().optional(),
  dryRun: z.boolean().default(false),
  quickMode: z.boolean().default(false),
  confirmSpec: z.boolean().default(false),
  memory: memorySchema.default({
    enabled: true,
    maxDocuments: 500,
    maxDocumentSizeKb: 100,
    layers: { enabled: true },
  } satisfies z.input<typeof memorySchema>),
  codexSubagents: codexSubagentsSchema.optional(),
  // Rubric evaluation is a debug tier: useful for offline grading of phase
  // output but it doubles the cost of every phase (handler re-run on
  // `needs_revision` + grader model call). Default is OFF; opt in via config
  // override, CLI flag (`--enable-rubrics`), or the `debug` / `nightly`
  // auxiliary profile. Leaving it on for production runs is an easy way to
  // burn budget without tangible product gain.
  rubrics: z.object({
    enabled: z.boolean().default(false),
    maxIterations: z.number().default(3),
    graderModel: z.string().optional(),
  }).default({ enabled: false, maxIterations: 3 }),
  maxParallelBatches: z.number().default(3),
  roles: z.record(z.string(), roleBudgetSchema).default({}),
  retryPolicy: retryPolicySchema.default({
    provider_limit: "checkpoint",
    verification_failed: { maxAttempts: 2 },
    identical_failure_abort: true,
  } satisfies z.input<typeof retryPolicySchema>),
  // Phase 3: opt-in lead-developer coordinator prompt wrapper. Default OFF —
  // each task dispatches directly to its subagent. See schema comment above.
  developmentCoordinator: developmentCoordinatorSchema.default({
    enabled: false,
  } satisfies z.input<typeof developmentCoordinatorSchema>),
  // Phase 8: auxiliary loop profile — controls whether rubric, memory capture,
  // and quality-fix retries run. Default `minimal` for production cost
  // discipline; switch to `debug` / `nightly` for offline analysis runs.
  auxiliaryProfile: auxiliaryProfileSchema,
  // Phase C: optional mid-phase user clarification. Default OFF — autonomous
  // behavior is preserved. Flip on to let phases prompt on a real TTY.
  interactive: interactiveSchema.default(DEFAULT_INTERACTIVE),
});

export type Config = z.infer<typeof ConfigSchema>;
export type CodexSubagentsConfig = z.infer<typeof codexSubagentsSchema>;

export function getCodexSubagentsConfig(config?: Config): CodexSubagentsConfig {
  return {
    ...DEFAULT_CODEX_SUBAGENTS,
    ...(config?.codexSubagents ?? {}),
  };
}

/**
 * Phase 8: resolve the effective auxiliary-loop feature flags given the
 * configured profile. Call this at call sites that would otherwise fire
 * rubric/memory/quality-fix loops — returns a flat boolean surface so each
 * site stays readable.
 *
 * - `rubric`: run the post-phase rubric grader + re-execution loop
 * - `memoryCapturePerTask`: capture learnings per-task (debug only; phase-end
 *   capture is controlled separately and always runs when `config.memory.enabled`)
 * - `qualityFixRetry`: trigger the auto-fix agent when a batch fails quality
 * - `verbose`: emit extra diagnostics for auxiliary loops
 */
export function resolveAuxiliaryFlags(config: Pick<Config, "auxiliaryProfile" | "rubrics">): {
  rubric: boolean;
  memoryCapturePerTask: boolean;
  qualityFixRetry: boolean;
  verbose: boolean;
} {
  const profile = config.auxiliaryProfile;
  if (profile === "minimal") {
    return {
      rubric: false,
      memoryCapturePerTask: false,
      qualityFixRetry: false,
      verbose: false,
    };
  }
  if (profile === "nightly") {
    return {
      // Nightly runs opt back into rubric/memory regardless of the rubrics
      // top-level flag so offline analysis has full signal.
      rubric: true,
      memoryCapturePerTask: false,
      qualityFixRetry: true,
      verbose: false,
    };
  }
  // debug: everything on
  return {
    rubric: config.rubrics?.enabled !== false,
    memoryCapturePerTask: true,
    qualityFixRetry: true,
    verbose: true,
  };
}

export function loadConfig(configPath?: string): Config {
  const defaults: Record<string, unknown> = {
    posthogApiKey: process.env['POSTHOG_API_KEY'],
    githubToken: process.env['GITHUB_TOKEN'],
    slackWebhookUrl: process.env['SLACK_WEBHOOK_URL'],
  };

  if (configPath) {
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    const raw: unknown = JSON.parse(readFileSync(absPath, "utf-8"));
    const fileConfig = isRecord(raw) ? raw : {};
    return ConfigSchema.parse({ ...defaults, ...fileConfig });
  }

  // Try loading from default location
  const defaultPath = resolve(".autonomous-dev/config.json");
  if (existsSync(defaultPath)) {
    const raw: unknown = JSON.parse(readFileSync(defaultPath, "utf-8"));
    const fileConfig = isRecord(raw) ? raw : {};
    return ConfigSchema.parse({ ...defaults, ...fileConfig });
  }

  return ConfigSchema.parse(defaults);
}
