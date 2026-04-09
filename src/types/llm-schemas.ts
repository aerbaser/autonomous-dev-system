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

/** Spec without domain — used during ideation where domain is added separately. */
export const ProductSpecWithoutDomainSchema = z.object({
  summary: z.string(),
  userStories: z.array(UserStorySchema),
  nonFunctionalRequirements: z.array(z.string()),
});

export const ProductSpecSchema = ProductSpecWithoutDomainSchema.extend({
  domain: DomainAnalysisSchema,
});

export const ArchDesignSchema = z.object({
  techStack: z.record(z.string(), z.string()),
  components: z.array(z.string()),
  apiContracts: z.string(),
  databaseSchema: z.string(),
  fileStructure: z.string(),
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
    phase: z.string(),
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

// --- ProjectState sub-schemas (mirrors interfaces in project-state.ts) ---

export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const LspConfigSchema = z.object({
  language: z.string(),
  server: z.string(),
  installCommand: z.string(),
  installed: z.boolean(),
});

export const McpDiscoverySchema = z.object({
  name: z.string(),
  source: z.string(),
  config: McpServerConfigSchema,
  installed: z.boolean(),
  reason: z.string(),
});

export const PluginDiscoverySchema = z.object({
  name: z.string(),
  source: z.string(),
  scope: z.enum(["project", "user"]),
  installed: z.boolean(),
  reason: z.string(),
});

export const OssToolStateSchema = z.object({
  name: z.string(),
  repo: z.string(),
  type: z.enum(["agent", "skill", "hook", "mcp-server", "pattern"]),
  integrationPlan: z.string(),
  integrated: z.boolean(),
});

export const StackEnvironmentSchema = z.object({
  lspServers: z.array(LspConfigSchema),
  mcpServers: z.array(McpDiscoverySchema),
  plugins: z.array(PluginDiscoverySchema),
  openSourceTools: z.array(OssToolStateSchema),
  claudeMd: z.string(),
});

export const AgentBlueprintSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
  evaluationCriteria: z.array(z.string()),
  version: z.number(),
  score: z.number().optional(),
});

export const TaskStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  assignedAgent: z.string().optional(),
  parentTaskId: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

export const DeploymentStateSchema = z.object({
  id: z.string(),
  environment: z.enum(["staging", "production"]),
  url: z.string().optional(),
  timestamp: z.string(),
  status: z.enum(["deploying", "deployed", "failed", "rolled-back"]),
});

const ABTestResultInnerSchema = z.object({
  winner: z.string(),
  pValue: z.number(),
  metrics: z.record(z.string(), z.number()),
});

export const ABTestStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  hypothesis: z.string(),
  variants: z.array(z.string()),
  featureFlagKey: z.string(),
  status: z.enum(["setup", "running", "analyzing", "completed"]),
  result: ABTestResultInnerSchema.optional(),
});

export const EvolutionEntrySchema = z.object({
  id: z.string(),
  target: z.string(),
  type: z.enum(["agent_prompt", "tool_config", "phase_logic", "quality_threshold", "environment_setup"]),
  diff: z.string(),
  scoreBefore: z.number(),
  scoreAfter: z.number(),
  accepted: z.boolean(),
  timestamp: z.string(),
});

export const PhaseCheckpointSchema = z.object({
  phase: z.string(),
  completedTasks: z.array(z.string()),
  pendingTasks: z.array(z.string()),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Re-export ProjectState schema for loadState validation
export const ProjectStateSchema = z.object({
  id: z.string(),
  idea: z.string(),
  currentPhase: z.string(),
  spec: ProductSpecSchema.nullable().catch(null),
  architecture: ArchDesignSchema.nullable().catch(null),
  environment: StackEnvironmentSchema.nullable().catch(null),
  agents: z.array(AgentBlueprintSchema).catch([]),
  tasks: z.array(TaskStateSchema).catch([]),
  deployments: z.array(DeploymentStateSchema).catch([]),
  abTests: z.array(ABTestStateSchema).catch([]),
  evolution: z.array(EvolutionEntrySchema).catch([]),
  checkpoints: z.array(PhaseCheckpointSchema).catch([]),
  baselineScore: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Deployment and Monitoring structured output ---

export const DeploymentResultSchema = z.object({
  status: z.enum(["deployed", "failed"]),
  url: z.string().optional(),
  reason: z.string().optional(),
});

export const MonitoringResultSchema = z.object({
  status: z.enum(["healthy", "regression", "improvement"]),
  description: z.string(),
});

// --- Testing and Review structured output ---

export const TestingResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  details: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  status: z.enum(["approved", "requested_changes"]),
  summary: z.string().optional(),
});

// --- Rubric evaluation schemas ---

export const RubricCriterionSchema = z.object({
  name: z.string(),
  description: z.string(),
  weight: z.number(),
  threshold: z.number(),
});

export const CriterionScoreSchema = z.object({
  criterionName: z.string(),
  score: z.number(),
  passed: z.boolean(),
  feedback: z.string(),
});

export const RubricResultSchema = z.object({
  rubricName: z.string(),
  scores: z.array(CriterionScoreSchema),
  verdict: z.enum(["satisfied", "needs_revision", "failed"]),
  overallScore: z.number(),
  summary: z.string(),
  iteration: z.number(),
});

// --- Memory store schemas ---

export { MemoryDocumentSchema, MemoryIndexSchema, MemoryHistoryEntrySchema, MemoryLearningSchema, MemoryLearningsArraySchema } from "../state/memory-types.js";
