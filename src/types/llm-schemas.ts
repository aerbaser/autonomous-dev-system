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
