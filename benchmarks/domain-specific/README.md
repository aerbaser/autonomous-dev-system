# Domain-Specific Benchmarks

This directory holds per-project custom benchmarks that test domain knowledge and project-specific patterns.

## Purpose

While the standard benchmarks (code-quality, test-generation, etc.) measure general development capabilities, domain-specific benchmarks test how well the agent understands your particular project's patterns, conventions, and domain logic.

## How to add benchmarks

1. Create a `tasks.json` file in this directory following the standard schema:

```json
{
  "id": "domain-specific",
  "name": "Project-Specific Benchmarks",
  "verifier": "llm",
  "weight": 0.1,
  "tasks": [
    {
      "instruction": "Implement a feature using our project's specific patterns...",
      "evaluationPrompt": "Rate adherence to project conventions 0-1: ...",
      "timeout": 120000,
      "fixture": {
        "files": {
          "src/example.ts": "// your project's boilerplate"
        }
      }
    }
  ]
}
```

2. The benchmark runner will automatically pick it up via `loadBenchmarkTasks("domain-specific")`.

## Examples of domain-specific tasks

- **API consistency**: "Add a new endpoint following our existing REST patterns"
- **State management**: "Implement a new state slice using our store patterns"
- **Error handling**: "Add error handling following our error hierarchy"
- **Testing patterns**: "Write tests using our custom test utilities and fixtures"
- **Domain modeling**: "Model a new entity in our domain following existing conventions"

## Tips

- Keep fixtures small — include only the minimum context needed for the task.
- Write evaluation prompts that focus on adherence to your project's conventions, not general code quality (that's covered by standard benchmarks).
- Update tasks as your project's patterns evolve.
