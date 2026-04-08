import type { Benchmark } from "./benchmark-types.js";
import { CODE_QUALITY_FIXTURE, TEST_GENERATION_FIXTURE } from "./benchmark-fixtures.js";

export function getDefaultBenchmarks(): Benchmark[] {
  return [
    {
      id: "code-quality",
      name: "Generated Code Quality",
      tasks: [
        {
          instruction:
            "In the project directory, implement a REST API endpoint handler function in src/register.ts for user registration. " +
            "It should validate email format, require passwords of 8+ characters, hash the password (use the hashPassword utility from src/utils.ts — improve it to use crypto.scrypt), " +
            "and return structured JSON responses with appropriate status codes. Include error handling for duplicate emails.",
          evaluationPrompt:
            "Rate this code on a 0-1 scale for: correctness (does it compile and handle all cases), " +
            "security (proper password hashing, no plaintext storage), error handling (all failure modes covered), " +
            "code structure (clean, modular, readable). Average the four sub-scores.",
          timeout: 120_000,
          fixture: CODE_QUALITY_FIXTURE,
        },
        {
          instruction:
            "Write a function in src/rate-limiter.ts that implements rate limiting using a sliding window algorithm. " +
            "The function should accept (key: string, windowMs: number, maxRequests: number) and return { allowed: boolean, remaining: number, retryAfterMs: number }. " +
            "Use an in-memory Map for storage. Handle edge cases: first request, window expiry, concurrent keys.",
          evaluationPrompt:
            "Rate this code 0-1: algorithm correctness (proper sliding window, not fixed window), " +
            "edge case handling (first request, expiry, boundary), performance (O(1) or O(log n) lookup), " +
            "readability (clear naming, comments only where needed). Average the four sub-scores.",
          timeout: 120_000,
          fixture: CODE_QUALITY_FIXTURE,
        },
      ],
      verifier: "llm",
      weight: 0.3,
    },
    {
      id: "test-generation",
      name: "Test Generation Quality",
      tasks: [
        {
          instruction:
            "Read src/cart.ts and write comprehensive tests in src/cart.test.ts using Node.js built-in test runner (node:test). " +
            "Cover: adding items, removing items, applying discounts, checkout flow, error cases (empty cart checkout, invalid discount), " +
            "edge cases (negative quantities, zero prices, duplicate item IDs).",
          evaluationPrompt:
            "Rate test quality 0-1: coverage of happy paths (add/remove/discount/checkout all tested), " +
            "edge cases (empty cart, negative quantities, overflow, duplicate IDs), error paths (invalid discount, empty checkout), " +
            "test independence (each test is self-contained), clear naming (test names describe behavior). Average the five sub-scores.",
          timeout: 120_000,
          fixture: TEST_GENERATION_FIXTURE,
        },
      ],
      verifier: "llm",
      weight: 0.25,
    },
    {
      id: "spec-completeness",
      name: "Specification Completeness",
      tasks: [
        {
          instruction:
            "Create a product specification for a collaborative document editor (like Google Docs lite)",
          evaluationPrompt:
            "Rate spec quality 0-1: user story coverage, acceptance criteria specificity, " +
            "non-functional requirements, edge cases considered, domain analysis. Average the scores.",
          timeout: 120_000,
        },
      ],
      verifier: "llm",
      weight: 0.2,
    },
    {
      id: "architecture-quality",
      name: "Architecture Decisions",
      tasks: [
        {
          instruction:
            "Design the architecture for a real-time chat application supporting 10k concurrent users",
          evaluationPrompt:
            "Rate architecture 0-1: appropriate tech choices, scalability plan, component separation, " +
            "API design, data model, trade-off analysis. Average the scores.",
          timeout: 120_000,
        },
      ],
      verifier: "llm",
      weight: 0.15,
    },
    {
      id: "build-success",
      name: "Build and Lint Success",
      tasks: [
        {
          instruction: "npm run build",
          expectedOutput: "exit_code_0",
          timeout: 60_000,
        },
      ],
      verifier: "deterministic",
      weight: 0.1,
    },
  ];
}
