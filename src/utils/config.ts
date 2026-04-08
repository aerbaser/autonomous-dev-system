import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

const selfImproveSchema = z.object({
  enabled: z.boolean().default(true),
  maxIterations: z.number().default(50),
  nightlyOptimize: z.boolean().default(false),
});

const deployTargetSchema = z.object({
  provider: z.enum(["vercel", "netlify", "docker", "custom"]),
  config: z.record(z.string(), z.string()).default({}),
});

export const ErrorType = {
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
} as const;

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType];

export const ConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
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
  budgetUsd: z.number().positive().optional(),
  dryRun: z.boolean().default(false),
  quickMode: z.boolean().default(false),
  confirmSpec: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath?: string): Config {
  const defaults: Record<string, unknown> = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    posthogApiKey: process.env.POSTHOG_API_KEY,
    githubToken: process.env.GITHUB_TOKEN,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
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
