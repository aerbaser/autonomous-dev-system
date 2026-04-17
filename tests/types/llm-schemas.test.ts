import { describe, it, expect } from "vitest";
import {
  ArchDesignSchema,
  OssToolArraySchema,
  ProjectStateSchema,
} from "../../src/types/llm-schemas.js";

/**
 * Stream-2 data-integrity tests: verify that `.catch(defaultValue)` has been
 * removed from LLM-output schemas so malformed input surfaces as a ZodError
 * instead of being silently coerced to a default.
 *
 * State-file-load schemas (ProjectStateSchema) MUST remain lenient for
 * backward compatibility — those tests live here too.
 */
describe("LLM-output schemas: strict at the LLM boundary", () => {
  describe("ArchDesignSchema.components (previously .catch([]))", () => {
    const validRest = {
      techStack: { runtime: "node" },
      apiContracts: "REST + OpenAPI",
      databaseSchema: "postgres",
      fileStructure: "src/",
    };

    it("rejects invalid components instead of silently falling back to []", () => {
      const result = ArchDesignSchema.safeParse({
        ...validRest,
        // Each entry is missing the required `description` field.
        components: [{ name: "svc-a" }, { name: "svc-b" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const componentIssue = result.error.issues.find((i) =>
          i.path.includes("components"),
        );
        expect(componentIssue).toBeDefined();
      }
    });

    it("rejects a non-array components value", () => {
      const result = ArchDesignSchema.safeParse({
        ...validRest,
        components: "not-an-array",
      });
      expect(result.success).toBe(false);
    });

    it("accepts well-formed components", () => {
      const result = ArchDesignSchema.safeParse({
        ...validRest,
        components: [
          { name: "api", description: "REST API", dependencies: [] },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("OssToolArraySchema[].type (previously .catch(\"pattern\"))", () => {
    it("rejects unknown tool types instead of silently coercing to 'pattern'", () => {
      const result = OssToolArraySchema.safeParse([
        {
          name: "some-tool",
          repo: "github.com/foo/bar",
          type: "totally-made-up",
          integrationPlan: "drop it in and hope",
        },
      ]);
      expect(result.success).toBe(false);
      if (!result.success) {
        const typeIssue = result.error.issues.find((i) => i.path.includes("type"));
        expect(typeIssue).toBeDefined();
      }
    });

    it("accepts the known tool types", () => {
      const result = OssToolArraySchema.safeParse([
        {
          name: "good",
          repo: "github.com/foo/bar",
          type: "mcp-server",
          integrationPlan: "install and wire",
        },
      ]);
      expect(result.success).toBe(true);
    });
  });
});

describe("State-load schemas: stay lenient for backward compat", () => {
  const minimalValid = {
    id: "id-1",
    idea: "test",
    currentPhase: "ideation",
    spec: null,
    architecture: null,
    environment: null,
    agents: [],
    tasks: [],
    completedPhases: [],
    phaseResults: {},
    deployments: [],
    abTests: [],
    evolution: [],
    checkpoints: [],
    baselineScore: 0,
    totalCostUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("ProjectStateSchema coerces invalid `agents` back to [] via .catch([])", () => {
    const result = ProjectStateSchema.safeParse({
      ...minimalValid,
      agents: "garbage-not-array",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toEqual([]);
    }
  });

  it("ProjectStateSchema coerces invalid `architecture` to null via .nullable().catch(null)", () => {
    const result = ProjectStateSchema.safeParse({
      ...minimalValid,
      architecture: { completely: "wrong shape" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.architecture).toBeNull();
    }
  });

  it("ProjectStateSchema coerces invalid totalCostUsd to 0", () => {
    const result = ProjectStateSchema.safeParse({
      ...minimalValid,
      totalCostUsd: "not a number",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalCostUsd).toBe(0);
    }
  });
});
