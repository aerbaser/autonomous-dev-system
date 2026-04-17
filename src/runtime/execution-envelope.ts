import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { platform } from "node:os";
import { z } from "zod";
import { errMsg } from "../utils/shared.js";

const execFileAsync = promisify(execFile);

/**
 * Execution envelope validated once per run and handed to every delegated task.
 *
 * Goal: agents should never spend tokens self-correcting paths, detecting the
 * package manager, or guessing the current branch. All that context is
 * validated upfront by the orchestrator and embedded in the task prompt.
 */
export const ExecutionEnvelopeSchema = z.object({
  /** Canonical absolute path to the project root (fs-verified). */
  projectRoot: z.string(),
  /** Canonical absolute writable area (may equal projectRoot). */
  writableRoot: z.string(),
  /** Current git branch, or `null` when not inside a git repo. */
  branch: z.string().nullable(),
  /**
   * Package root when it diverges from projectRoot (monorepo subproject).
   * Undefined when the project is single-package.
   */
  packageRoot: z.string().optional(),
  /** Explicit whitelist of commands delegated agents may invoke for verification. */
  allowedVerificationCommands: z.array(z.string()),
  environment: z.object({
    nodeVersion: z.string(),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
    os: z.string(),
  }),
});

export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;

/**
 * Package manager detection by lockfile. `bun` wins over `pnpm` wins over
 * `yarn` wins over `npm` when multiple lockfiles are present (newer/more
 * specific managers take precedence).
 */
export function detectPackageManager(
  projectRoot: string,
): ExecutionEnvelope["environment"]["packageManager"] {
  if (existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(projectRoot, "package.json"))) return "npm";
  return "unknown";
}

async function detectGitBranch(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectRoot, timeout: 5000 },
    );
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export interface BuildEnvelopeOptions {
  /**
   * Package subdirectory (relative to projectRoot or absolute). Useful for
   * monorepos. When omitted or equal to projectRoot, `packageRoot` is not
   * populated on the envelope.
   */
  packageRoot?: string;
  /** Override writable root; defaults to projectRoot. */
  writableRoot?: string;
  /**
   * Override the command whitelist. When omitted, a sensible default is
   * derived from the detected package manager.
   */
  allowedVerificationCommands?: string[];
}

function defaultVerificationCommands(
  pm: ExecutionEnvelope["environment"]["packageManager"],
): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm test", "pnpm typecheck", "pnpm lint"];
    case "yarn":
      return ["yarn test", "yarn typecheck", "yarn lint"];
    case "bun":
      return ["bun test", "bun run typecheck", "bun run lint"];
    case "npm":
    case "unknown":
    default:
      return ["npm test", "npm run typecheck", "npm run lint"];
  }
}

/**
 * Validate `projectRoot`, derive environment metadata, and return a fully
 * populated execution envelope. Throws descriptive errors when the path does
 * not exist or is not a directory — these errors should crash the run fast
 * rather than get caught and papered over.
 */
export async function buildEnvelope(
  projectRoot: string,
  options: BuildEnvelopeOptions = {},
): Promise<ExecutionEnvelope> {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("buildEnvelope: projectRoot must be a non-empty string");
  }

  const resolvedRoot = isAbsolute(projectRoot)
    ? projectRoot
    : resolve(projectRoot);

  if (!existsSync(resolvedRoot)) {
    throw new Error(
      `buildEnvelope: projectRoot does not exist: ${resolvedRoot}`,
    );
  }

  let rootStat;
  try {
    rootStat = statSync(resolvedRoot);
  } catch (err) {
    throw new Error(
      `buildEnvelope: failed to stat projectRoot "${resolvedRoot}": ${errMsg(err)}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(
      `buildEnvelope: projectRoot is not a directory: ${resolvedRoot}`,
    );
  }

  // packageRoot: optional, validated when provided
  let packageRoot: string | undefined;
  if (options.packageRoot) {
    const pr = isAbsolute(options.packageRoot)
      ? options.packageRoot
      : resolve(resolvedRoot, options.packageRoot);
    if (!existsSync(pr)) {
      throw new Error(`buildEnvelope: packageRoot does not exist: ${pr}`);
    }
    if (!statSync(pr).isDirectory()) {
      throw new Error(`buildEnvelope: packageRoot is not a directory: ${pr}`);
    }
    if (pr !== resolvedRoot) packageRoot = pr;
  }

  const writableRoot = options.writableRoot
    ? isAbsolute(options.writableRoot)
      ? options.writableRoot
      : resolve(resolvedRoot, options.writableRoot)
    : resolvedRoot;

  if (!existsSync(writableRoot)) {
    throw new Error(
      `buildEnvelope: writableRoot does not exist: ${writableRoot}`,
    );
  }
  if (!statSync(writableRoot).isDirectory()) {
    throw new Error(
      `buildEnvelope: writableRoot is not a directory: ${writableRoot}`,
    );
  }

  const packageManager = detectPackageManager(packageRoot ?? resolvedRoot);
  const branch = await detectGitBranch(resolvedRoot);

  const envelope: ExecutionEnvelope = {
    projectRoot: resolvedRoot,
    writableRoot,
    branch,
    ...(packageRoot ? { packageRoot } : {}),
    allowedVerificationCommands:
      options.allowedVerificationCommands ??
      defaultVerificationCommands(packageManager),
    environment: {
      nodeVersion: process.version,
      packageManager,
      os: platform(),
    },
  };

  // Self-validate — catches schema drift between runtime and Zod.
  return ExecutionEnvelopeSchema.parse(envelope);
}

/**
 * Render the envelope as a stable XML block embedded in task prompts. Using
 * a structured tag lets downstream agents spot and skip the block when they
 * don't need it, and it mirrors the `wrapUserInput` convention already used
 * throughout the codebase.
 */
export function renderEnvelopeBlock(envelope: ExecutionEnvelope): string {
  const lines = [
    "<execution-envelope>",
    `  projectRoot: ${envelope.projectRoot}`,
    `  writableRoot: ${envelope.writableRoot}`,
    `  branch: ${envelope.branch ?? "(not a git repo)"}`,
    ...(envelope.packageRoot ? [`  packageRoot: ${envelope.packageRoot}`] : []),
    `  os: ${envelope.environment.os}`,
    `  nodeVersion: ${envelope.environment.nodeVersion}`,
    `  packageManager: ${envelope.environment.packageManager}`,
    `  allowedVerificationCommands: ${envelope.allowedVerificationCommands.join(" | ")}`,
    "</execution-envelope>",
  ];
  return lines.join("\n");
}
