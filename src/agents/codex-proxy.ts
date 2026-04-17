import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import type { AgentBlueprint } from "../state/project-state.js";
import { getCodexSubagentsConfig, type Config } from "../utils/config.js";

type ProxyableAgent = Pick<AgentBlueprint, "name" | "role" | "systemPrompt" | "tools">;

const REQUIRED_PROXY_TOOLS = ["Read", "Write", "Bash", "Glob", "Grep"] as const;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function dedupeTools(tools: readonly string[]): string[] {
  return Array.from(new Set(tools));
}

function buildCodexExecCommand(config: Config): string {
  const codex = getCodexSubagentsConfig(config);
  const command = ["codex"];

  command.push("-a", codex.approvalPolicy);
  command.push("-s", codex.sandbox);
  command.push("exec");
  command.push("--json");

  if (codex.ephemeral) {
    command.push("--ephemeral");
  }

  if (codex.skipGitRepoCheck) {
    command.push("--skip-git-repo-check");
  }

  command.push("-C", resolve(config.projectDir));
  command.push("-m", codex.model);
  command.push("-c", `reasoning_effort="${codex.reasoningEffort}"`);

  return command.map(shellEscape).join(" ");
}

function buildProxyTools(agent: ProxyableAgent): string[] {
  const tools = agent.tools.filter((tool) => tool !== "Agent");
  return dedupeTools([...tools, ...REQUIRED_PROXY_TOOLS]);
}

function buildCodexProxyPrompt(agent: ProxyableAgent, config: Config): string {
  const codex = getCodexSubagentsConfig(config);
  const execCommand = buildCodexExecCommand(config);
  const proxyDir = resolve(config.stateDir, "codex-proxy");

  return `You are the "${agent.name}" subagent, but the actual implementation work must be executed by Codex CLI.

You are operating as a thin proxy for the parent Opus orchestrator:
- Externally, behave like a normal subagent.
- Internally, forward the assignment to Codex using model "${codex.model}" and reasoning effort "${codex.reasoningEffort}".
- Do not implement product code directly yourself. The only direct actions you may take are preparing the forwarded prompt, invoking Codex, and reading Codex's final report.

Required workflow:
1. Create the directory ${proxyDir} if it does not exist.
2. Create two temp files inside that directory: one prompt file and one result file.
3. Copy everything after the marker "## FORWARDED ASSIGNMENT FOR CODEX" into the prompt file verbatim.
4. Run Codex with this exact command, appending your temp file paths:
   ${execCommand} -o "$RESULT_FILE" < "$PROMPT_FILE"
5. Read the result file and use it as the source of truth for your reply.
6. Return a concise report for the parent orchestrator:
   - what Codex changed
   - what Codex verified or tested
   - any failure, blocker, or residual risk

Failure handling:
- If the codex command fails, report the failure clearly and include the relevant stderr output.
- Do not claim success unless Codex actually completed the assignment.

## FORWARDED ASSIGNMENT FOR CODEX
${agent.systemPrompt}`;
}

export function isCodexSubagentModeEnabled(config?: Config): config is Config {
  return Boolean(config && getCodexSubagentsConfig(config).enabled);
}

export function buildRunnableAgentDefinition(
  agent: ProxyableAgent,
  config?: Config,
): AgentDefinition {
  if (!isCodexSubagentModeEnabled(config)) {
    return {
      description: `${agent.role}: ${agent.name}`,
      prompt: agent.systemPrompt,
      tools: agent.tools,
    };
  }

  return {
    description: `${agent.role}: ${agent.name} (Codex-backed)`,
    prompt: buildCodexProxyPrompt(agent, config),
    tools: buildProxyTools(agent),
  };
}
