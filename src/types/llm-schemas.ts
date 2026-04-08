import { z } from "zod";

export const DomainAnalysisSchema = z.object({
  classification: z.string(),
  specializations: z.array(z.string()),
  requiredRoles: z.array(z.string()),
  requiredMcpServers: z.array(z.string()),
  techStack: z.array(z.string()),
});

export const UserStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(["must", "should", "could", "wont"]),
});

export const ProductSpecSchema = z.object({
  summary: z.string(),
  userStories: z.array(UserStorySchema),
  nonFunctionalRequirements: z.array(z.string()),
  domain: DomainAnalysisSchema,
});

export const ArchDesignSchema = z.object({
  techStack: z.record(z.string(), z.string()),
  components: z.array(z.string()),
  apiContracts: z.string(),
  databaseSchema: z.string(),
  fileStructure: z.string(),
});

export const ABTestDesignSchema = z.object({
  tests: z.array(z.object({
    name: z.string(),
    hypothesis: z.string(),
    variants: z.array(z.string()),
    featureFlagKey: z.string(),
  })),
});

// --- Schemas for JSON.parse validation across the codebase ---

export const ABTestDesignResponseSchema = z.object({
  name: z.string(),
  hypothesis: z.string(),
  variants: z.array(z.string()),
  featureFlagKey: z.string(),
});

export const ABTestAnalysisSchema = z.object({
  testId: z.string().optional(),
  winner: z.string().optional(),
  pValue: z.number().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});

export const TaskResultsSchema = z.object({
  tasks: z.array(z.object({
    title: z.string(),
    status: z.string(),
  })),
});

export const TaskDecompositionSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    estimatedComplexity: z.enum(["low", "medium", "high"]),
    dependencies: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
  })),
});

export const OssToolArraySchema = z.array(z.object({
  name: z.string(),
  repo: z.string(),
  type: z.string(),
  integrationPlan: z.string(),
}));

export const SessionStoreSchema = z.object({
  sessions: z.record(z.string(), z.object({
    agentRole: z.string(),
    sessionId: z.string(),
    createdAt: z.string(),
    lastUsed: z.string(),
  })),
});

export const RegistryDataSchema = z.object({
  blueprints: z.record(z.string(), z.object({
    name: z.string(),
    role: z.string(),
    systemPrompt: z.string(),
    tools: z.array(z.string()),
    mcpServers: z.record(z.string(), z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })).optional(),
    model: z.enum(["opus", "sonnet", "haiku"]).optional(),
    evaluationCriteria: z.array(z.string()),
    version: z.number(),
    score: z.number().optional(),
  })),
  performanceHistory: z.record(z.string(), z.array(z.object({
    benchmarkId: z.string(),
    score: z.number(),
    timestamp: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }))),
});

export const ExternalBenchmarkFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  verifier: z.enum(["deterministic", "llm"]),
  weight: z.number(),
  tasks: z.array(z.object({
    instruction: z.string(),
    timeout: z.number(),
    expectedOutput: z.string().optional(),
    evaluationPrompt: z.string().optional(),
  })),
});

export const ToolConfigResponseSchema = z.array(z.string());

export const PhaseLogicResponseSchema = z.object({
  maxTurns: z.number().optional(),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
});

export const BenchmarkRunResultSchema = z.object({
  totalScore: z.number(),
  results: z.array(z.object({
    benchmarkId: z.string(),
    score: z.number(),
    details: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
    costUsd: z.number(),
  })),
  totalCostUsd: z.number(),
});

export const DomainAgentArraySchema = z.array(z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  evaluationCriteria: z.array(z.string()),
}));

export const StackResearchResultSchema = z.object({
  lspServers: z.array(z.object({
    language: z.string(),
    server: z.string(),
    installCommand: z.string(),
    reason: z.string().optional(),
  })).optional(),
  mcpServers: z.array(z.object({
    name: z.string(),
    source: z.string(),
    config: z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
    }),
    reason: z.string().optional(),
  })).optional(),
  plugins: z.array(z.object({
    name: z.string(),
    source: z.string(),
    scope: z.string().optional(),
    reason: z.string().optional(),
  })).optional(),
  openSourceTools: z.array(z.object({
    name: z.string(),
    repo: z.string(),
    type: z.string(),
    integrationPlan: z.string(),
  })).optional(),
  claudeMdSuggestions: z.array(z.string()).optional(),
});

// Re-export ProjectState schema for loadState validation
export const ProjectStateSchema = z.object({
  id: z.string(),
  idea: z.string(),
  currentPhase: z.string(),
  spec: z.unknown().nullable(),
  architecture: z.unknown().nullable(),
  environment: z.unknown().nullable(),
  agents: z.array(z.unknown()),
  tasks: z.array(z.unknown()),
  deployments: z.array(z.unknown()),
  abTests: z.array(z.unknown()),
  evolution: z.array(z.unknown()),
  checkpoints: z.array(z.unknown()),
  sessionIds: z.record(z.string(), z.string()),
  baselineScore: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Safely extract JSON from LLM text output. Tries to find the first valid JSON object. */
export function extractJson(text: string): string | null {
  // Try to find JSON by looking for balanced braces starting from each {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Not valid JSON, continue looking
          start = -1;
        }
      }
    }
  }
  return null;
}
