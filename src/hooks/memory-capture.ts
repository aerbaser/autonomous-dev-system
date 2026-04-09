import { query } from "@anthropic-ai/claude-agent-sdk";
import { consumeQuery } from "../utils/sdk-helpers.js";
import { extractFirstJson, wrapUserInput, errMsg } from "../utils/shared.js";
import { MemoryLearningsArraySchema } from "../state/memory-types.js";
import type { MemoryStore } from "../state/memory-store.js";
import type { PhaseResult } from "../phases/types.js";
import type { Phase } from "../state/project-state.js";
import type { Config } from "../utils/config.js";
import type { EventBus } from "../events/event-bus.js";

export async function capturePhaseMemories(
  phaseResult: PhaseResult,
  phase: Phase,
  memoryStore: MemoryStore,
  config: Config,
  eventBus?: EventBus,
): Promise<void> {
  if (!config.memory?.enabled) return;

  const model = config.memory.captureModel ?? config.subagentModel;
  const phaseOutput = phaseResult.error
    ? `Phase failed: ${phaseResult.error}`
    : `Phase succeeded. Tasks: ${phaseResult.state.tasks.filter((t) => t.status === "completed").length} completed.`;

  const prompt = `You extract key learnings from development phases. Return only valid JSON.

Extract 2-5 key learnings from this phase that would help in future sessions.
Return ONLY a JSON array of objects with fields: topic (string), content (string), tags (string array).
Each learning should be a concise, actionable insight.

Phase: ${phase}
${wrapUserInput("phase-output", phaseOutput)}`;

  try {
    const stream = query({
      prompt,
      options: {
        model,
        maxTurns: 1,
      },
    });

    const result = await consumeQuery(stream, `memory-capture:${phase}`);

    // Try parsing as array first (the expected format)
    const arrayMatch = result.result.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = MemoryLearningsArraySchema.safeParse(JSON.parse(arrayMatch[0]));
        if (parsed.success) {
          await writeLearnings(parsed.data, phase, memoryStore, eventBus);
          return;
        }
      } catch {
        // Fall through to object extraction
      }
    }

    // Fallback: try extracting individual JSON objects
    const jsonStr = extractFirstJson(result.result);
    if (!jsonStr) return;

    try {
      const parsed = MemoryLearningsArraySchema.safeParse([JSON.parse(jsonStr)]);
      if (parsed.success) {
        await writeLearnings(parsed.data, phase, memoryStore, eventBus);
      }
    } catch {
      // Could not parse — silently skip
    }
  } catch (err) {
    console.warn(`[memory-capture] Failed to capture learnings for phase "${phase}": ${errMsg(err)}`);
  }
}

async function writeLearnings(
  learnings: Array<{ topic: string; content: string; tags: string[] }>,
  phase: Phase,
  memoryStore: MemoryStore,
  eventBus?: EventBus,
): Promise<void> {
  for (const learning of learnings) {
    try {
      const tags = [
        phase,
        ...learning.tags.filter((t) => t !== phase),
      ];
      await memoryStore.write(learning.topic, learning.content, tags);
      eventBus?.emit("memory.capture", {
        phase,
        key: learning.topic,
        summary: learning.content.slice(0, 100),
      });
    } catch (err) {
      console.warn(`[memory-capture] Failed to write learning "${learning.topic}": ${errMsg(err)}`);
    }
  }
}
