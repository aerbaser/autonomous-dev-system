import type { Phase } from "../state/project-state.js";
import type { Rubric } from "./rubric.js";

const DEVELOPMENT_RUBRIC: Rubric = {
  name: "development",
  description: "Evaluates development phase output for correctness, testing, security, and adherence to architecture.",
  criteria: [
    {
      name: "compiles_cleanly",
      description: "Code compiles without TypeScript errors or build failures",
      weight: 0.25,
      threshold: 0.8,
    },
    {
      name: "tests_exist_and_pass",
      description: "Unit/integration tests exist for new code and all tests pass",
      weight: 0.25,
      threshold: 0.7,
    },
    {
      name: "no_security_issues",
      description: "No obvious security vulnerabilities (injection, XSS, hardcoded secrets, etc.)",
      weight: 0.2,
      threshold: 0.8,
    },
    {
      name: "follows_architecture",
      description: "Implementation follows the architectural design and component boundaries",
      weight: 0.15,
      threshold: 0.7,
    },
    {
      name: "acceptance_criteria_met",
      description: "User story acceptance criteria are addressed in the implementation",
      weight: 0.15,
      threshold: 0.7,
    },
  ],
};

const TESTING_RUBRIC: Rubric = {
  name: "testing",
  description: "Evaluates test quality, coverage, edge cases, and reliability.",
  criteria: [
    {
      name: "adequate_coverage",
      description: "Test coverage is adequate for the codebase (critical paths covered)",
      weight: 0.3,
      threshold: 0.7,
    },
    {
      name: "edge_cases_covered",
      description: "Edge cases and boundary conditions are tested",
      weight: 0.25,
      threshold: 0.6,
    },
    {
      name: "error_handling_tested",
      description: "Error paths and exception handling are tested",
      weight: 0.25,
      threshold: 0.6,
    },
    {
      name: "no_flaky_patterns",
      description: "Tests do not rely on timing, external services, or non-deterministic behavior",
      weight: 0.2,
      threshold: 0.8,
    },
  ],
};

const REVIEW_RUBRIC: Rubric = {
  name: "review",
  description: "Evaluates code review thoroughness, security identification, and specificity.",
  criteria: [
    {
      name: "all_files_reviewed",
      description: "All changed files have been reviewed and commented on",
      weight: 0.25,
      threshold: 0.8,
    },
    {
      name: "security_issues_flagged",
      description: "Security vulnerabilities are identified with severity ratings",
      weight: 0.3,
      threshold: 0.7,
    },
    {
      name: "performance_checked",
      description: "Performance implications are evaluated where relevant",
      weight: 0.2,
      threshold: 0.6,
    },
    {
      name: "specific_line_references",
      description: "Review comments reference specific files and line numbers",
      weight: 0.25,
      threshold: 0.7,
    },
  ],
};

const ARCHITECTURE_RUBRIC: Rubric = {
  name: "architecture",
  description: "Evaluates architectural design quality, scalability, and justification.",
  criteria: [
    {
      name: "scalability_addressed",
      description: "Design addresses scalability concerns and growth paths",
      weight: 0.25,
      threshold: 0.7,
    },
    {
      name: "separation_of_concerns",
      description: "Clear separation of concerns with well-defined component boundaries",
      weight: 0.3,
      threshold: 0.7,
    },
    {
      name: "tech_stack_justified",
      description: "Technology choices are justified with clear reasoning",
      weight: 0.2,
      threshold: 0.6,
    },
    {
      name: "deployment_strategy",
      description: "Deployment and infrastructure strategy is defined",
      weight: 0.25,
      threshold: 0.6,
    },
  ],
};

const PHASE_RUBRICS: Partial<Record<Phase, Rubric>> = {
  development: DEVELOPMENT_RUBRIC,
  testing: TESTING_RUBRIC,
  review: REVIEW_RUBRIC,
  architecture: ARCHITECTURE_RUBRIC,
};

export function getPhaseRubric(phase: Phase): Rubric | null {
  return PHASE_RUBRICS[phase] ?? null;
}
