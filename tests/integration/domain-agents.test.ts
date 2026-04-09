/**
 * Integration tests for domain agent selection pipeline.
 * Tests the full analyzeDomain → generateDomainAgents pipeline with mocked LLM,
 * focusing on validation, parsing, criteria padding, and fallback behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/utils/config.js";
import type { DomainAnalysis } from "../../src/state/project-state.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { analyzeDomain, generateDomainAgents } = await import("../../src/agents/domain-analyzer.js");

const mockedQuery = vi.mocked(query);

function makeQueryStream(resultText: string, structuredOutput?: unknown) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true as const };
          done = true;
          return {
            value: {
              type: "result",
              subtype: "success",
              result: resultText,
              session_id: "test-session",
              total_cost_usd: 0.005,
              num_turns: 1,
              structured_output: structuredOutput,
            },
            done: false as const,
          };
        },
      };
    },
    close() {},
  } as any;
}

function makeConfig(): Config {
  return {
    model: "claude-sonnet-4-6",
    subagentModel: "claude-sonnet-4-6",
    selfImprove: { enabled: false, maxIterations: 50, nightlyOptimize: false },
    projectDir: ".",
    stateDir: ".autonomous-dev",
    memory: { enabled: false, maxDocuments: 500, maxDocumentSizeKb: 100 },
    rubrics: { enabled: false, maxIterations: 3 },
  } as Config;
}

const fintechDomain: DomainAnalysis = {
  classification: "fintech",
  specializations: ["payment processing", "risk calculation"],
  requiredRoles: ["financial-analyst", "compliance-officer"],
  requiredMcpServers: ["stripe", "plaid"],
  techStack: ["typescript", "postgresql"],
};

describe("Domain Agent Selection — integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("analyzeDomain", () => {
    it("returns valid domain analysis when LLM responds with correct JSON", async () => {
      const domainJson = JSON.stringify({
        classification: "fintech",
        specializations: ["trading", "risk calculation"],
        requiredRoles: ["financial-analyst"],
        requiredMcpServers: ["stripe"],
        techStack: ["typescript"],
      });

      mockedQuery.mockReturnValue(makeQueryStream(domainJson));

      const result = await analyzeDomain("Build a stock trading platform", makeConfig());

      expect(result.classification).toBe("fintech");
      expect(result.requiredRoles).toContain("financial-analyst");
      expect(result.techStack).toContain("typescript");
    });

    it("returns default domain when LLM query throws", async () => {
      mockedQuery.mockImplementation(() => {
        throw new Error("Network error");
      });

      const result = await analyzeDomain("Build something", makeConfig());

      // Default domain has web-application classification
      expect(result.classification).toBe("web-application");
      expect(result.requiredRoles).toHaveLength(0);
    });

    it("returns default domain when LLM returns malformed JSON", async () => {
      mockedQuery.mockReturnValue(makeQueryStream("I cannot determine the domain."));

      const result = await analyzeDomain("Build something", makeConfig());

      expect(result.classification).toBe("web-application");
    });

    it("returns default domain when JSON fails Zod validation", async () => {
      // Missing required fields
      mockedQuery.mockReturnValue(makeQueryStream('{"classification": "fintech"}'));

      const result = await analyzeDomain("Build a trading platform", makeConfig());

      expect(result.classification).toBe("web-application");
    });
  });

  describe("generateDomainAgents", () => {
    it("returns empty array immediately when domain has no required roles", async () => {
      const domain: DomainAnalysis = { ...fintechDomain, requiredRoles: [] };

      const agents = await generateDomainAgents("Some idea", domain, makeConfig());

      expect(agents).toHaveLength(0);
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("returns well-formed agent blueprints for domain-specific roles", async () => {
      const blueprints = [
        {
          name: "financial-analyst",
          role: "Financial Data Analyst",
          systemPrompt: "You are a financial analyst specializing in risk calculations.\n\nYour job is to validate all monetary computations and ensure compliance.\n\nAlways use integer arithmetic for currency values.\n\nOutput structured JSON with all calculations documented.",
          tools: ["Read", "Write", "Bash"],
          evaluationCriteria: [
            "All monetary values use integer cents",
            "Every formula has a documented source",
            "Compliance checks cover all regulations",
          ],
        },
      ];

      mockedQuery.mockReturnValue(makeQueryStream(JSON.stringify(blueprints)));

      const agents = await generateDomainAgents("Build a trading platform", fintechDomain, makeConfig());

      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe("financial-analyst");
      expect(agents[0]!.role).toBe("Financial Data Analyst");
      expect(agents[0]!.evaluationCriteria).toHaveLength(3);
      expect(agents[0]!.version).toBe(1);
    });

    it("pads evaluation criteria to minimum 3 when LLM returns fewer", async () => {
      const blueprints = [
        {
          name: "compliance-officer",
          role: "Compliance Officer",
          systemPrompt: "You ensure regulatory compliance.\n\nYou review all financial transactions for regulatory issues.\n\nYou maintain audit trails for all decisions.\n\nOutput compliance reports in structured JSON.",
          tools: ["Read", "Grep"],
          evaluationCriteria: ["All transactions have audit trails"],  // only 1 criterion
        },
      ];

      mockedQuery.mockReturnValue(makeQueryStream(JSON.stringify(blueprints)));

      const agents = await generateDomainAgents("Build a fintech app", fintechDomain, makeConfig());

      expect(agents[0]!.evaluationCriteria.length).toBeGreaterThanOrEqual(3);
    });

    it("does not pad when blueprint already has 3+ evaluation criteria", async () => {
      const blueprints = [
        {
          name: "data-scientist",
          role: "Data Scientist",
          systemPrompt: "You analyze data patterns.\n\nYou build ML models for predictions.\n\nYou validate model accuracy and bias.\n\nOutput results in structured JSON.",
          tools: ["Read", "Write", "Bash"],
          evaluationCriteria: [
            "Model accuracy exceeds baseline",
            "No data leakage in training pipeline",
            "Feature importance is documented",
            "Bias metrics are reported",
          ],
        },
      ];

      mockedQuery.mockReturnValue(makeQueryStream(JSON.stringify(blueprints)));

      const agents = await generateDomainAgents("Build an ML platform", fintechDomain, makeConfig());

      // Should keep original 4 criteria, not truncate or pad
      expect(agents[0]!.evaluationCriteria).toHaveLength(4);
    });

    it("returns empty array when LLM returns no JSON array", async () => {
      mockedQuery.mockReturnValue(makeQueryStream("I cannot generate agents for this domain."));

      const agents = await generateDomainAgents("Build something", fintechDomain, makeConfig());

      expect(agents).toHaveLength(0);
    });

    it("returns empty array when LLM query throws", async () => {
      mockedQuery.mockImplementation(() => {
        throw new Error("API error");
      });

      const agents = await generateDomainAgents("Build something", fintechDomain, makeConfig());

      expect(agents).toHaveLength(0);
    });

    it("full pipeline: analyzeDomain → generateDomainAgents produces coherent team", async () => {
      const domainResponse = JSON.stringify({
        classification: "healthtech",
        specializations: ["clinical data", "HIPAA compliance"],
        requiredRoles: ["clinical-analyst"],
        requiredMcpServers: ["fhir"],
        techStack: ["typescript", "postgresql"],
      });

      const agentResponse = JSON.stringify([
        {
          name: "clinical-analyst",
          role: "Clinical Data Analyst",
          systemPrompt: "You analyze clinical data for healthcare applications.\n\nYou ensure HIPAA compliance in all data handling.\n\nYou validate clinical workflows against regulations.\n\nOutput structured reports with compliance status.",
          tools: ["Read", "Write", "Grep"],
          evaluationCriteria: [
            "All PHI is properly anonymized",
            "HIPAA audit requirements are met",
            "Data retention policies are enforced",
          ],
        },
      ]);

      mockedQuery
        .mockReturnValueOnce(makeQueryStream(domainResponse))
        .mockReturnValueOnce(makeQueryStream(agentResponse));

      const domain = await analyzeDomain("Build a patient management system", makeConfig());
      const agents = await generateDomainAgents("Build a patient management system", domain, makeConfig());

      expect(domain.classification).toBe("healthtech");
      expect(domain.requiredRoles).toContain("clinical-analyst");
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe("clinical-analyst");
      expect(agents[0]!.evaluationCriteria).toHaveLength(3);
      expect(agents[0]!.version).toBe(1);
    });
  });
});
