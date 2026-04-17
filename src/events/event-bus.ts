import type { Phase } from "../state/project-state.js";

// --- Event types ---

export type EventType =
  | "agent.query.start"
  | "agent.query.end"
  | "agent.tool.use"
  | "agent.tool.result"
  | "session.state"
  | "orchestrator.phase.start"
  | "orchestrator.phase.end"
  | "orchestrator.interrupt"
  | "evaluation.rubric.start"
  | "evaluation.rubric.end"
  | "memory.capture"
  | "memory.recall";

// --- Event data interfaces ---

export interface AgentQueryStartData {
  phase: Phase;
  agentName: string;
  model: string;
  promptLength: number;
  label?: string | undefined;
}

export interface AgentQueryEndData {
  phase: Phase;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens served from Anthropic's prompt cache on this call. A high ratio
   * of cacheReadInputTokens to (inputTokens + cacheReadInputTokens) means the
   * Stream 1 prompt-caching strategy is working.
   */
  cacheReadInputTokens?: number;
  /**
   * Tokens that were written into the prompt cache on this call (first-hit
   * cost). These get reused as cache reads on subsequent identical prefixes.
   */
  cacheCreationInputTokens?: number;
  /**
   * Per-model usage breakdown from SDKResultSuccess.modelUsage. Keys are
   * model IDs (e.g. "claude-opus-4-6", "claude-sonnet-4-6"). Present when a
   * single query exercises multiple models (lead Opus + Sonnet subagents).
   */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
  }>;
  costUsd: number;
  durationMs: number;
  success: boolean;
  label?: string | undefined;
  sessionId?: string | undefined;
  turns?: number | undefined;
}

export interface AgentToolUseData {
  phase: Phase;
  agentName: string;
  toolName: string;
  inputSummary: string;
}

export interface AgentToolResultData {
  phase: Phase;
  agentName: string;
  toolName: string;
  success: boolean;
  durationMs: number;
}

export interface SessionStateData {
  phase: Phase;
  state: "idle" | "running" | "paused" | "terminated";
}

export interface OrchestratorPhaseStartData {
  phase: Phase;
}

export interface OrchestratorPhaseEndData {
  phase: Phase;
  success: boolean;
  costUsd?: number | undefined;
  durationMs: number;
}

export interface OrchestratorInterruptData {
  phase: Phase;
  reason: string;
  redirectTo?: Phase | undefined;
}

export interface EvaluationRubricStartData {
  phase: Phase;
  rubricName: string;
  iteration?: number;
}

export interface EvaluationRubricEndData {
  phase: Phase;
  rubricName: string;
  result?: string;
  iteration?: number;
}

export interface MemoryCaptureData {
  phase: Phase;
  key: string;
  summary: string;
}

export interface MemoryRecallData {
  phase: Phase;
  key: string;
  found: boolean;
}

// --- Event type map ---

export interface EventDataMap {
  "agent.query.start": AgentQueryStartData;
  "agent.query.end": AgentQueryEndData;
  "agent.tool.use": AgentToolUseData;
  "agent.tool.result": AgentToolResultData;
  "session.state": SessionStateData;
  "orchestrator.phase.start": OrchestratorPhaseStartData;
  "orchestrator.phase.end": OrchestratorPhaseEndData;
  "orchestrator.interrupt": OrchestratorInterruptData;
  "evaluation.rubric.start": EvaluationRubricStartData;
  "evaluation.rubric.end": EvaluationRubricEndData;
  "memory.capture": MemoryCaptureData;
  "memory.recall": MemoryRecallData;
}

// --- Event record ---

export interface EventRecord<T = unknown> {
  type: EventType;
  timestamp: string; // ISO 8601
  seq: number; // monotonic sequence number
  data: T;
}

// --- EventBus ---

type EventHandler<T = unknown> = (record: EventRecord<T>) => void;

export class EventBus {
  private seq = 0;
  private handlers = new Map<string, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();
  private buffer: EventRecord[] = [];
  private bufferSize: number;

  constructor(bufferSize = 1000) {
    this.bufferSize = bufferSize;
  }

  emit<K extends EventType>(type: K, data: EventDataMap[K]): EventRecord<EventDataMap[K]> {
    const record: EventRecord<EventDataMap[K]> = {
      type,
      timestamp: new Date().toISOString(),
      seq: this.seq++,
      data,
    };

    // Ring buffer
    this.buffer.push(record);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }

    // Notify type-specific handlers
    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(record);
      }
    }

    // Notify wildcard handlers
    for (const handler of this.allHandlers) {
      handler(record);
    }

    return record;
  }

  on<K extends EventType>(type: K, handler: EventHandler<EventDataMap[K]>): () => void {
    let typeHandlers = this.handlers.get(type);
    if (!typeHandlers) {
      typeHandlers = new Set();
      this.handlers.set(type, typeHandlers);
    }
    // Type-erased internally; public API preserves type safety via EventHandler<T>
    typeHandlers.add(handler as EventHandler);

    return () => {
      typeHandlers!.delete(handler as EventHandler);
      if (typeHandlers!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  onAll(handler: EventHandler): () => void {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  getEvents(filter?: { type?: EventType; since?: string }): EventRecord[] {
    let events = this.buffer;

    if (filter?.type) {
      events = events.filter((e) => e.type === filter.type);
    }

    if (filter?.since) {
      const since = filter.since;
      events = events.filter((e) => e.timestamp >= since);
    }

    return [...events];
  }

  getSequence(): number {
    return this.seq;
  }

  clear(): void {
    this.buffer = [];
    this.handlers.clear();
    this.allHandlers.clear();
    this.seq = 0;
  }
}
