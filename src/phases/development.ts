// Thin orchestrator — re-exports types and the main runner
// to preserve backward compatibility for all existing imports.

export type {
  DevTask,
  TaskDecomposition,
  BatchResult,
  TaskResult,
} from "./development-types.js";

export { runDevelopment } from "./development-runner.js";
