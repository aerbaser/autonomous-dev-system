import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock sandbox before importing verifiers
vi.mock("../../src/self-improve/sandbox.js", () => ({
  runCommandInSandbox: vi.fn(),
}));

// Mock SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { runCommandInSandbox } = await import(
  "../../src/self-improve/sandbox.js"
);
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const {
  createDeterministicVerifier,
  createLlmVerifier,
} = await import("../../src/self-improve/verifiers.js");

const mockedRunCommand = vi.mocked(runCommandInSandbox);
const mockedQuery = vi.mocked(query);

// Helper to create an async iterable from messages
function mockQueryStream(messages: unknown[]) {
  return (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
}

describe("Verifiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Deterministic verifier ──

  describe("createDeterministicVerifier", () => {
    it("returns score 1.0 for passing command", async () => {
      mockedRunCommand.mockResolvedValue({
        success: true,
        output: "ok",
        exitCode: 0,
        durationMs: 100,
      });

      const verifier = createDeterministicVerifier();
      const result = await verifier.run({
        instruction: "npm run build",
        timeout: 60_000,
      });

      expect(result.score).toBe(1.0);
      expect(result.costUsd).toBe(0);
      expect(verifier.type).toBe("deterministic");
      expect(mockedRunCommand).toHaveBeenCalledWith("npm run build", {
        timeoutMs: 60_000,
        cwd: expect.any(String),
      });
    });

    it("returns score 0.0 for failing command", async () => {
      mockedRunCommand.mockResolvedValue({
        success: false,
        output: "",
        error: "Command failed with exit code 1",
        exitCode: 1,
        durationMs: 50,
      });

      const verifier = createDeterministicVerifier();
      const result = await verifier.run({
        instruction: "npm run build",
        timeout: 60_000,
      });

      expect(result.score).toBe(0.0);
      expect(result.costUsd).toBe(0);
    });

    it("uses explicit command over task instruction", async () => {
      mockedRunCommand.mockResolvedValue({
        success: true,
        output: "",
        exitCode: 0,
        durationMs: 10,
      });

      const verifier = createDeterministicVerifier("echo hello");
      await verifier.run({
        instruction: "npm run build",
        timeout: 30_000,
      });

      expect(mockedRunCommand).toHaveBeenCalledWith(
        "echo hello",
        expect.any(Object)
      );
    });

    it("returns score 0 for empty command", async () => {
      const verifier = createDeterministicVerifier("");
      const result = await verifier.run({
        instruction: "   ",
        timeout: 30_000,
      });

      expect(result.score).toBe(0);
      expect(mockedRunCommand).not.toHaveBeenCalled();
    });

    it("handles sandbox timeout gracefully", async () => {
      mockedRunCommand.mockResolvedValue({
        success: false,
        output: "",
        error: "Timeout after 5000ms",
        exitCode: null,
        durationMs: 5000,
      });

      const verifier = createDeterministicVerifier();
      const result = await verifier.run({
        instruction: "sleep 999",
        timeout: 5_000,
      });

      expect(result.score).toBe(0.0);
    });
  });

  // ── LLM verifier ──

  describe("createLlmVerifier", () => {
    it("returns scored result from LLM evaluation", async () => {
      // First call: generate output
      // Second call: evaluate
      let callCount = 0;
      mockedQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockQueryStream([
            {
              type: "result",
              subtype: "success",
              result: "Generated code here",
              total_cost_usd: 0.01,
            },
          ]);
        }
        return mockQueryStream([
          {
            type: "result",
            subtype: "success",
            result: "0.85",
            total_cost_usd: 0.005,
          },
        ]);
      });

      const verifier = createLlmVerifier("Rate this code 0-1");
      const result = await verifier.run({
        instruction: "Write a hello world function",
        evaluationPrompt: "Rate this code 0-1",
        timeout: 60_000,
      });

      expect(result.score).toBe(0.85);
      expect(result.costUsd).toBeCloseTo(0.015);
      expect(verifier.type).toBe("llm");
      expect(mockedQuery).toHaveBeenCalledTimes(2);
    });

    it("returns 0 when agent produces no output", async () => {
      mockedQuery.mockImplementation(() =>
        mockQueryStream([
          {
            type: "result",
            subtype: "error",
            errors: ["Agent failed"],
            result: "",
            total_cost_usd: 0.002,
          },
        ])
      );

      const verifier = createLlmVerifier("Rate this");
      const result = await verifier.run({
        instruction: "Do something",
        evaluationPrompt: "Rate this",
        timeout: 60_000,
      });

      expect(result.score).toBe(0);
      // Only one call — no evaluation call since output was empty
      expect(mockedQuery).toHaveBeenCalledTimes(1);
    });

    it("clamps score to 0-1 range", async () => {
      let callCount = 0;
      mockedQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockQueryStream([
            {
              type: "result",
              subtype: "success",
              result: "Some output",
              total_cost_usd: 0.01,
            },
          ]);
        }
        return mockQueryStream([
          {
            type: "result",
            subtype: "success",
            result: "1.5",
            total_cost_usd: 0.005,
          },
        ]);
      });

      const verifier = createLlmVerifier("Rate this");
      const result = await verifier.run({
        instruction: "Do something",
        evaluationPrompt: "Rate this",
        timeout: 60_000,
      });

      expect(result.score).toBe(1.0);
    });

    it("returns 0 for non-numeric evaluation result", async () => {
      let callCount = 0;
      mockedQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockQueryStream([
            {
              type: "result",
              subtype: "success",
              result: "Some output",
              total_cost_usd: 0.01,
            },
          ]);
        }
        return mockQueryStream([
          {
            type: "result",
            subtype: "success",
            result: "not a number",
            total_cost_usd: 0.005,
          },
        ]);
      });

      const verifier = createLlmVerifier("Rate this");
      const result = await verifier.run({
        instruction: "Do something",
        evaluationPrompt: "Rate this",
        timeout: 60_000,
      });

      expect(result.score).toBe(0);
    });
  });

  // ── Type definitions ──

  describe("type definitions", () => {
    it("deterministic verifier has correct type property", () => {
      const verifier = createDeterministicVerifier();
      expect(verifier.type).toBe("deterministic");
      expect(typeof verifier.run).toBe("function");
    });

    it("llm verifier has correct type property", () => {
      const verifier = createLlmVerifier("Rate this");
      expect(verifier.type).toBe("llm");
      expect(typeof verifier.run).toBe("function");
    });
  });
});
