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
  development: z.number().default(60),
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
  development: 60,
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

const memorySchema = z.object({
  enabled: z.boolean().default(true),
  maxDocuments: z.number().default(500),
  maxDocumentSizeKb: z.number().default(100),
  captureModel: z.string().optional(),
});

const deployTargetSchema = z.object({
  provider: z.enum(["vercel", "netlify", "docker", "custom"]),
  config: z.record(z.string(), z.string()).default({}),
});

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
  } satisfies z.input<typeof memorySchema>),
  rubrics: z.object({
    enabled: z.boolean().default(true),
    maxIterations: z.number().default(3),
    graderModel: z.string().optional(),
  }).default({ enabled: true, maxIterations: 3 }),
});

export type Config = z.infer<typeof ConfigSchema>;

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
