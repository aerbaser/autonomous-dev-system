---
name: typescript
description: TypeScript conventions and strict-mode patterns for autonomous-dev-system. ALWAYS invoke when editing any .ts file in this project, or when the user asks about types, Zod schemas, SDK usage, or runtime guards. Covers: strict tsconfig pitfalls (noUncheckedIndexedAccess, exactOptionalPropertyTypes), Node16 ESM import rules, Claude Agent SDK patterns, and project-specific helpers.
---

# TypeScript guidance for autonomous-dev-system

## tsconfig is strict — code accordingly

Project enforces:
- `strict: true`
- `noUncheckedIndexedAccess` — `arr[0]` is `T | undefined`, always narrow
- `exactOptionalPropertyTypes` — `{ x?: string }` ≠ `{ x: string | undefined }`; do not pass `undefined` where a key is optional
- `noPropertyAccessFromIndexSignature` — use `obj['key']` (bracket) when the key comes from an index signature; dot only for declared properties
- `noImplicitOverride` — every method overriding a parent must have `override`

### Common pitfalls
```ts
// ❌ breaks under noUncheckedIndexedAccess
const first = items[0];
first.foo;                    // TS2532

// ✅ narrow, or use non-null assertion when truly safe
const first = items[0];
if (!first) return;
first.foo;

// ❌ breaks under exactOptionalPropertyTypes
type Opts = { name?: string };
const o: Opts = { name: undefined };   // error

// ✅
const o: Opts = name !== undefined ? { name } : {};
```

## ESM / Node16 — imports must be explicit

The project uses `"module": "Node16"`. This means:

- **Always include `.js` extension** in relative imports, even though source is `.ts`:
  ```ts
  import { foo } from "./bar.js";          // ✅
  import { foo } from "./bar";             // ❌ — tsc will complain
  ```
- `package.json` is `"type": "module"` — no `require()`, use `import`.
- For JSON, use `with { type: "json" }` assertion or the `resolveJsonModule` path.

## Zod — validate, never cast

The project has Zod schemas for every LLM output (`src/types/llm-schemas.ts`) and state (`ProjectStateSchema`).

- **Never use `as T` on data from LLM, disk, or network.** Always `.safeParse()` and handle the error branch.
- `safeParse` return shape: `{ success: true, data } | { success: false, error }`.
- For LLM text responses, use `extractFirstJson()` from `src/utils/shared.ts` first (handles strings containing braces), then parse with the Zod schema.

```ts
import { ProductSpecSchema } from "../types/llm-schemas.js";
import { extractFirstJson } from "../utils/shared.js";

const jsonText = extractFirstJson(llmText);
if (!jsonText) throw new Error("No JSON in LLM output");

const parsed = ProductSpecSchema.safeParse(JSON.parse(jsonText));
if (!parsed.success) {
  // fall back to text path or throw — never cast
  throw new Error(`Spec parse failed: ${parsed.error.message}`);
}
// parsed.data is typed
```

## Claude Agent SDK patterns

- **Never call `query()` directly and iterate** — use `consumeQuery()` from `src/utils/sdk-helpers.ts`, which returns `{ messages, cost }`. `costUsd` must flow back through every `PhaseResult`.
- `HookCallback` type comes from `@anthropic-ai/claude-agent-sdk` — import it explicitly in hooks under `src/hooks/`.
- Agent blueprints live in `src/agents/base-blueprints.ts` via `getBaseBlueprints()` / `getBaseAgentNames()`. Extend blueprints, don't duplicate them.
- For maximum turns across phases, use `getMaxTurns()` from sdk-helpers — it respects config.

## Runtime I/O — always async

- **Use `execFile` promisified**, never `execFileSync`. The orchestrator must stay non-blocking for SIGINT handling and cost accounting.
- Shell out via `execFile(cmd, [args])`, never concatenate user input into a shell string.

```ts
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);

const { stdout } = await execFile("git", ["status", "--porcelain"]);
```

## User input sanitization

Any text that originated from the LLM or the user's idea string flows through `wrapUserInput(tag, content)` from `src/utils/shared.ts` before being re-embedded in a prompt. This delimits the content with XML tags so prompt-injection attempts in the payload are clearly fenced.

```ts
import { wrapUserInput } from "../utils/shared.js";

const prompt = `Review this idea:\n${wrapUserInput("user_idea", rawIdea)}`;
```

Never interpolate `rawIdea` directly into a prompt string.

## Error handling

- Use `errMsg(err)` from `shared.ts` to get a string from `unknown` — don't assume `err.message` exists.
- For hook/tool failures, throw a typed error subclass rather than returning `null`.
- `noUncheckedIndexedAccess` means you cannot trust `.find()` / `.at()` / `arr[i]` results without narrowing — always guard.

## Project module boundaries (don't cross)

| If you need...                     | Use                                                           |
|------------------------------------|---------------------------------------------------------------|
| `ProjectState` type / persistence  | `src/state/project-state.ts`                                  |
| Shared helpers (`errMsg`, JSON)    | `src/utils/shared.ts`                                         |
| SDK consumption                    | `src/utils/sdk-helpers.ts`                                    |
| Phase return types                 | `src/phases/types.ts` (NOT orchestrator.ts)                   |
| Base agent blueprints              | `src/agents/base-blueprints.ts`                               |
| Canonical failure reason codes     | `src/types/failure-codes.ts` (`CanonicalFailureReasonCodeSchema`) |
| Phase list / transitions           | `src/types/phases.ts` (`ALL_PHASES`, `OPTIONAL_PHASES`, `VALID_TRANSITIONS`) |
| LLM/state Zod schemas              | `src/types/llm-schemas.ts`                                    |

## Before marking a TS task done

1. `npm run typecheck` — zero errors
2. `npm test` — 776/777 (one known pre-existing failure: `orchestrator-autonomy.test.ts` non-interactive mode)
3. `npm run lint` — eslint clean
4. Verify no new `.ts` imports drop the `.js` extension
5. Verify any new Zod schema is exported from `src/types/llm-schemas.ts` and has `.safeParse()` callsites, not `as` casts

## Further reading

- Enterprise-grade general-purpose TS skill (not installed here, optional reference): https://github.com/SpillwaveSolutions/mastering-typescript-skill
