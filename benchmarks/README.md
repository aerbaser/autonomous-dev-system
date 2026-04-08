# Benchmarks

External benchmark task definitions for the self-improvement system.

## Structure

```
benchmarks/
├── README.md
├── code-quality/
│   └── tasks.json          # Code generation quality benchmarks
├── spec-completeness/
│   └── tasks.json          # Specification writing benchmarks
├── test-generation/
│   └── tasks.json          # Test generation benchmarks
├── architecture-quality/
│   └── tasks.json          # Architecture design benchmarks
└── domain-specific/
    └── README.md           # Per-project custom benchmarks
```

## How it works

The benchmark runner (`src/self-improve/benchmarks.ts`) loads tasks from these JSON files at runtime via `loadBenchmarkTasks(benchmarkId)`. If the external file doesn't exist, the system falls back to built-in inline defaults.

This means:
- **External files are optional** — the system works out of the box with inline defaults.
- **External files override inline defaults** — drop a `tasks.json` into the appropriate directory to customize benchmarks without touching source code.

## tasks.json format

Each `tasks.json` follows this schema:

```json
{
  "id": "benchmark-id",
  "name": "Human-readable name",
  "verifier": "llm" | "deterministic",
  "weight": 0.3,
  "tasks": [
    {
      "instruction": "What the agent should do",
      "evaluationPrompt": "How to score the output (for llm verifier)",
      "timeout": 120000,
      "fixture": {
        "files": {
          "path/to/file.ts": "file contents"
        },
        "setupCommand": "optional shell command after fixture setup"
      }
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique benchmark identifier, matches directory name |
| `name` | string | yes | Display name |
| `verifier` | `"llm"` or `"deterministic"` | yes | How results are scored |
| `weight` | number | yes | Weight in overall score (0-1) |
| `tasks` | array | yes | List of benchmark tasks |
| `tasks[].instruction` | string | yes | What the agent should do |
| `tasks[].evaluationPrompt` | string | for llm verifier | Scoring rubric |
| `tasks[].expectedOutput` | string | for deterministic | Expected output to match |
| `tasks[].timeout` | number | yes | Timeout in milliseconds |
| `tasks[].fixture` | object | no | Files to set up before running |

## Adding a custom benchmark

1. Create a new directory under `benchmarks/` (e.g. `benchmarks/my-benchmark/`)
2. Add a `tasks.json` following the schema above
3. Register the benchmark in your configuration or call `loadBenchmarkTasks("my-benchmark")` directly

For project-specific benchmarks, see `domain-specific/README.md`.
