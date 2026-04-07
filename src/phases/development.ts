import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../utils/config.js";
import type { ProjectState } from "../state/project-state.js";
import type { PhaseResult } from "../orchestrator.js";
import { AgentRegistry } from "../agents/registry.js";
import { getAgentDefinitions } from "../agents/factory.js";
import { getMcpServerConfigs } from "../environment/mcp-manager.js";
import { qualityGateHook } from "../hooks/quality-gate.js";
import { auditLoggerHook } from "../hooks/audit-logger.js";
import { addTask } from "../state/project-state.js";

export async function runDevelopment(
  state: ProjectState,
  config: Config
): Promise<PhaseResult> {
  if (!state.spec || !state.architecture) {
    return { success: false, state, error: "Spec and architecture required" };
  }

  const registry = new AgentRegistry(config.stateDir);
  const agentDefs = getAgentDefinitions(registry);

  // Get MCP servers from environment
  const mcpServers = state.environment
    ? getMcpServerConfigs(state.environment.mcpServers)
    : {};

  // Create tasks from pending user stories
  let updatedState = { ...state };
  const pendingStories = state.spec.userStories.filter(
    (us) => !state.tasks.some((t) => t.title === us.title)
  );

  for (const story of pendingStories) {
    updatedState = addTask(updatedState, {
      title: story.title,
      description: `${story.description}\n\nAcceptance Criteria:\n${story.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n")}`,
    });
  }

  console.log(`[development] ${updatedState.tasks.filter((t) => t.status === "pending").length} tasks to implement`);

  // Build the development prompt
  const prompt = `You are the lead developer. Implement the following project.

Architecture:
${JSON.stringify(state.architecture, null, 2)}

File Structure:
${state.architecture.fileStructure}

Tasks to implement (in priority order):
${updatedState.tasks
  .filter((t) => t.status === "pending")
  .map((t, i) => `${i + 1}. ${t.title}: ${t.description}`)
  .join("\n\n")}

Instructions:
- Follow the architecture exactly
- Use the developer subagent for implementation
- Use the qa-engineer subagent to write tests alongside code
- Each task should result in working, tested code
- Commit each completed task separately
- Read the CLAUDE.md for project conventions and available tools

Report when all tasks are complete with a summary of what was built.`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
      agents: agentDefs,
      hooks: {
        TaskCompleted: [{ hooks: [qualityGateHook] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [auditLoggerHook] }],
      },
      mcpServers,
    },
  })) {
    if ("result" in message && typeof message.result === "string") {
      resultText = message.result;
    }
  }

  // Mark all tasks as completed (the agent handled them)
  const finalState: ProjectState = {
    ...updatedState,
    tasks: updatedState.tasks.map((t) =>
      t.status === "pending"
        ? { ...t, status: "completed" as const, completedAt: new Date().toISOString() }
        : t
    ),
  };

  console.log("[development] Implementation complete");

  return {
    success: true,
    nextPhase: "testing",
    state: finalState,
  };
}
