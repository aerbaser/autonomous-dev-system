import { z } from "zod";
import { ALL_PHASES } from "./phases.js";

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

const CompetitorSchema = z.object({
  name: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  differentiator: z.string(),
});

const TargetAudienceSchema = z.object({
  primaryPersona: z.string(),
  secondaryPersonas: z.array(z.string()),
  marketSize: z.string().optional(),
});

const MvpScopeSchema = z.object({
  included: z.array(z.string()),
  excluded: z.array(z.string()),
  successMetrics: z.array(z.string()),
});

const TechStackRecommendationSchema = z.object({
  rationale: z.string(),
  recommended: z.array(z.string()),
  alternatives: z.array(z.string()),
});

/** Spec without domain — used during ideation where domain is added separately. */
export const ProductSpecWithoutDomainSchema = z.object({
  summary: z.string(),
  userStories: z.array(UserStorySchema),
  nonFunctionalRequirements: z.array(z.string()),
  targetAudience: TargetAudienceSchema.optional(),
  competitiveAnalysis: z.object({
    directCompetitors: z.array(CompetitorSchema),
    ourEdge: z.string(),
  }).optional(),
  mvpScope: MvpScopeSchema.optional(),
  techStackRecommendation: TechStackRecommendationSchema.optional(),
});

export const ProductSpecSchema = ProductSpecWithoutDomainSchema.extend({
  domain: DomainAnalysisSchema,
  // Populated by the specification phase after ideation — refined user stories,
  // concrete NFR thresholds, out-of-scope list, and integration boundaries.
  // Optional because ideation runs first and doesn't produce this yet.
  detailed: z.object({
    refinedUserStories: z.array(z.object({
      id: z.string(),
      title: z.string(),
      acceptanceCriteria: z.array(z.string()),
    })),
    refinedNonFunctionalRequirements: z.array(z.object({
      category: z.string(),
      requirement: z.string(),
      threshold: z.string(),
    })),
    outOfScope: z.array(z.string()),
    integrationBoundaries: z.array(z.object({
      name: z.string(),
      description: z.string(),
    })),
  }).optional(),
});

export const ArchTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  estimatedComplexity: z.enum(["low", "medium", "high"]),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  domain: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const ArchDesignSchema = z.object({
  techStack: z.record(z.string(), z.string()),
  // Strict at LLM-output boundary: invalid components must surface as a ZodError
  // so phase handlers fail loudly instead of silently falling back to [].
  components: z.array(z.object({
    name: z.string(),
    description: z.string(),
    dependencies: z.array(z.string()).default([]),
  })),
  apiContracts: z.string(),
  databaseSchema: z.string(),
  fileStructure: z.string(),
  taskDecomposition: z.object({ tasks: z.array(ArchTaskSchema) }).optional(),
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
    domain: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })),
});

export const OssToolArraySchema = z.array(z.object({
  name: z.string(),
  repo: z.string(),
  // Strict at LLM-output boundary: unknown tool types must surface as a ZodError
  // rather than being silently coerced to "pattern".
  type: z.enum(["agent", "skill", "hook", "mcp-server", "pattern"]),
  integrationPlan: z.string(),
}));

export const SessionStoreSchema = z.object({
  sessions: z.record(z.string(), z.object({
    phase: z.enum(ALL_PHASES),
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
  // HIGH-06: keywords emitted by domain-analyzer's LLM for task↔agent matching.
  // Optional here for backward compat with older mock fixtures (existing tests
  // construct blueprints without keywords); newly-generated blueprints always
  // include the field because the LLM JSON schema marks it required.
  keywords: z.array(z.string()).optional(),
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
  // HIGH-06: domain keywords for task↔agent matching in development-runner.
  // Optional at the Zod boundary so older persisted registries (which lack
  // the field) still load via safeParse. The LLM-emitting schema in
  // `src/agents/domain-analyzer.ts` marks the field as REQUIRED so all
  // newly-generated blueprints carry it.
  keywords: z.array(z.string()).optional(),
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
  domain: z.string().optional(),
  tags: z.array(z.string()).optional(),
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
  phase: z.enum(ALL_PHASES),
  completedTasks: z.array(z.string()),
  pendingTasks: z.array(z.string()),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PhaseResultSummarySchema = z.object({
  success: z.boolean(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});

const AnalysisStateSchema = z.object({
  winningVariant: z.string().optional(),
  statisticalConfidence: z.number().optional(),
  recommendedAction: z.enum(["ship", "rollback", "extend", "proceed"]),
  metricsSummary: z.string(),
  rationale: z.string(),
  timestamp: z.string(),
});

// Re-export ProjectState schema for loadState validation
export const ProjectStateSchema = z.object({
  id: z.string(),
  idea: z.string(),
  currentPhase: z.enum(ALL_PHASES),
  spec: ProductSpecSchema.nullable().catch(null),
  architecture: ArchDesignSchema.nullable().catch(null),
  environment: StackEnvironmentSchema.nullable().catch(null),
  agents: z.array(AgentBlueprintSchema).catch([]),
  tasks: z.array(TaskStateSchema).catch([]),
  completedPhases: z.array(z.enum(ALL_PHASES)).catch([]),
  phaseResults: z.record(z.string(), PhaseResultSummarySchema).catch({}),
  // v1.1 super-lead: append-only history per phase so backloops don't
  // clobber prior attempts. Parallel to phaseResults (which stays as
  // "latest attempt") to avoid test/callsite churn. Loaded leniently so
  // pre-v1.1 state.json files still parse.
  phaseAttempts: z.record(z.string(), z.array(PhaseResultSummarySchema)).catch({}),
  // v1.1 super-lead: per-transition-pair counter for livelock guard.
  // Key format: `${fromPhase}->${toPhase}` (plain string so Zod doesn't
  // blow up on unknown phase pairs in old state.json).
  backloopCounts: z.record(z.string(), z.number()).catch({}),
  deployments: z.array(DeploymentStateSchema).catch([]),
  abTests: z.array(ABTestStateSchema).catch([]),
  evolution: z.array(EvolutionEntrySchema).catch([]),
  checkpoints: z.array(PhaseCheckpointSchema).catch([]),
  analysis: AnalysisStateSchema.optional(),
  baselineScore: z.number(),
  totalCostUsd: z.number().catch(0),
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

// --- Specification expansion (detailed spec) ---

/**
 * Output of the specification phase — an expanded, implementation-ready spec.
 * Produced by refining the initial ProductSpec from ideation with tighter
 * acceptance criteria, concrete NFR thresholds, explicit out-of-scope, and
 * integration boundaries.
 */
export const DetailedSpecSchema = z.object({
  refinedUserStories: z.array(z.object({
    id: z.string(),
    title: z.string(),
    acceptanceCriteria: z.array(z.string()),
  })),
  refinedNonFunctionalRequirements: z.array(z.object({
    category: z.string(),
    requirement: z.string(),
    threshold: z.string(),
  })),
  outOfScope: z.array(z.string()),
  integrationBoundaries: z.array(z.object({
    name: z.string(),
    description: z.string(),
  })),
});

export type DetailedSpec = z.infer<typeof DetailedSpecSchema>;

// --- Analysis phase ---

/**
 * Output of the analysis phase — condenses deployment + A/B test results into
 * an actionable recommendation (ship/rollback/extend).
 */
export const AnalysisResultSchema = z.object({
  winningVariant: z.string().optional(),
  statisticalConfidence: z.number().optional(),
  recommendedAction: z.enum(["ship", "rollback", "extend", "proceed"]),
  metricsSummary: z.string(),
  rationale: z.string(),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

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

// --- Task receipt schemas (Phase 6) ---

export {
  TaskReceiptSchema,
  TaskReceiptEnvelopeSchema,
  TaskReceiptStatusSchema,
  VerificationCommandResultSchema,
  FailureReasonCodeSchema,
  receiptIsSuccess,
} from "./task-receipt.js";
export type {
  TaskReceipt,
  TaskReceiptEnvelope,
  TaskReceiptStatus,
  VerificationCommandResult,
  FailureReasonCode,
} from "./task-receipt.js";
