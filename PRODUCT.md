# Autonomous Dev System — продуктовый документ

> Единый источник правды по целям, архитектуре, механикам и текущему состоянию проекта.
> Для установки и команд — см. `README.md`. Для активного бэклога — `tasks-plans/tasks.md`.
> Исторические ревью и планы перенесены в `docs/archive/`.
>
> Актуализировано: 2026-04-17 (после spec↔code audit: unified FailureReasonCode, dead L1 layer removed, environment-setup made truly optional in --quick, dead schemas stripped). Tests: 777. TypeScript: clean.

---

## 1. Миссия и концепция

Self-improving multi-agent development system поверх Claude Agent SDK. Берёт идею продукта и автономно прогоняет её через полный жизненный цикл: спецификация → архитектура → setup окружения → реализация → тестирование → review → staging → A/B → production → monitoring. Параллельно система **улучшает сама себя** — бенчмарки оценивают агентов, hill-climbing мутирует их промпты, эффективные паттерны кристаллизуются в навыки (skills), провалы откладываются в слоистую память.

### Четыре ключевых дифференциатора

1. **Agent Factory — динамическое создание агентов под домен.** Вместо фиксированного набора ролей (PM/Dev/QA) система анализирует идею, классифицирует домен (fintech/trading, healthcare, data/ML, productivity/ai-email и т. д.) и генерирует blueprint'ы специализированных агентов с жёсткими constraints и конкретной предметной экспертизой.
2. **Stack Researcher — автонастройка окружения.** После фазы `architecture` определяется стек, и система ищет/ставит оптимальные LSP-серверы, MCP-серверы, плагины и OSS-инструменты под этот стек.
3. **Self-Improvement Loop (AutoAgent-style).** Benchmark-driven hill-climbing: мутация промптов/tool-config'ов/phase-logic → прогон в git-worktree sandbox → accept/reject по score.
4. **Continuous Product Improvement.** После деплоя автономный цикл: production metrics → гипотеза → A/B эксперимент → rollout/rollback → обучение.

### Чего система сознательно НЕ делает

- Не даёт UI для «вайб-кодинга» — это backend-оркестратор, не IDE. Real-time streaming и dashboard пока ограничены.
- Не скрывает стоимость — всё считается через `consumeQuery().cost`, но ответственность за бюджет на операторе (`--budget`).
- Не подменяет человека на critical-path решениях — есть `--confirm-spec` и L0 meta-rules для hard guardrails.

---

## 2. Архитектура верхнего уровня

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI (src/index.ts, commander)                                        │
│  run / status / phase / optimize / nightly / dashboard                │
└──────────────────────────┬───────────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Orchestrator (src/orchestrator.ts)                                   │
│  phase loop + retry + checkpoint + SIGINT-safe + EventBus + Ledger    │
└──┬──────────────────────┬──────────────────────┬────────────────────┘
   ▼                      ▼                      ▼
┌──────────┐     ┌───────────────┐      ┌───────────────────┐
│  Phases  │     │    Agents     │      │    Environment    │
│ (12 шт.) │     │ factory +     │      │  stack researcher │
│          │     │ registry +    │      │  LSP/MCP/plugin   │
│          │     │ domain-anal.  │      │  OSS scanner      │
└────┬─────┘     └──────┬────────┘      └────────┬──────────┘
     │                  │                        │
     ▼                  ▼                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│            Cross-cutting инфраструктура                               │
│  events/  evaluation/  hooks/  memory/  state/  governance/           │
│  runtime/ self-improve/ nightly/ dashboard/                           │
└──────────────────────────────────────────────────────────────────────┘
```

**Правило движения данных:**
- Каждая фаза возвращает `PhaseResult` (из `src/phases/types.ts`): `success`, `state`, `nextPhase?`, `costUsd`, `durationMs`, `rubricResult?`.
- Состояние сериализуется в `.autonomous-dev/state.json` через immutable updates + atomic write (`saveState` с `withStateLock`).
- События летят в `EventBus` → `EventLogger` пишет JSONL в `.autonomous-dev/events/{runId}.jsonl`.
- Run Ledger (`src/state/run-ledger.ts`) ведёт форензику топологии и spend per session/role.

---

## 3. 12-фазный жизненный цикл

`ALL_PHASES` определён в `src/types/phases.ts`. Переходы жёстко контролируются `VALID_TRANSITIONS`, обход невозможен. Фазы, помеченные **опциональными**, пропускаются в `--quick` режиме.

| # | Фаза | Основная задача | Артефакт в state | Опциональна |
|---|------|-----------------|-------------------|-------------|
| 1 | `ideation` | Idea → `ProductSpec` + `DomainAnalysis` (параллельно). WebSearch для market research. | `state.spec` | нет |
| 2 | `specification` | Раскрытие spec в implementation-ready детали (`ProductSpecSchema`, refined G/W/T, NFR thresholds). | обновляет `state.spec` | нет |
| 3 | `architecture` | Spec → tech stack (с точными версиями), components, apiContracts, databaseSchema, fileStructure, taskDecomposition. Запускает `buildAgentTeam()` для domain-агентов. | `state.architecture`, `state.agents` | нет |
| 4 | `environment-setup` | LSP/MCP/plugin discovery, OSS scan, генерация проектного `CLAUDE.md`. `Promise.allSettled` — non-critical steps не блокируют progress. | `state.environment` | да |
| 5 | `development` | `development-runner.ts` декомпозирует задачи (приоритет — `architecture.taskDecomposition`), группирует в батчи по DAG, запускает per-task агентов. После каждой задачи — структурированный `TaskReceipt` (см. §9). Quality gate после батча. | `state.tasks`, файлы в workspace | нет |
| 6 | `testing` | Генерация/прогон тестов, структурированный `TestingResultSchema`. | `state.phaseResults.testing` | нет |
| 7 | `review` | Reviewer агент, `ReviewResultSchema`, security-checks. | `state.phaseResults.review` | да |
| 8 | `staging` | Deploy preview в staging. Реально **общая функция `runDeployment`** (различие с `production` — через поле `environment` в state, не через handler). | `state.deployment` | нет |
| 9 | `ab-testing` | Feature flags + experiment design (PostHog — концептуально; интеграция неполная). | `state.abTests` | да |
| 10 | `analysis` | Анализ experiment data, формирование hypothesis для следующей итерации. | `state.phaseResults.analysis` | нет |
| 11 | `production` | Production deploy — **та же функция `runDeployment`**. | `state.deployment` | нет |
| 12 | `monitoring` | `MonitoringResultSchema`, сбор production metrics, триггер continuous improvement. | `state.phaseResults.monitoring` | да |

`OPTIONAL_PHASES` определён в **одном источнике** (`src/types/phases.ts`) и импортируется `orchestrator.ts` + `index.ts`. Содержит `["environment-setup", "review", "ab-testing", "monitoring"]`. В `--quick` режиме оркестратор пропускает их через quick-skip логику (handler не вызывается, `transitionPhase` на следующую фазу). `VALID_TRANSITIONS.architecture = ["environment-setup", "development"]` — оба перехода разрешены.

**Циклические переходы** (возврат из поздних фаз к development): `testing ↔ development`, `review ↔ development`, `analysis ↔ development`, `monitoring → development` — разрешены в `VALID_TRANSITIONS` (`src/state/project-state.ts:~86-93`) для повторной реализации при неудачном rubric verdict / failing tests.

**Gotcha:** исторический баг — если handler возвращает `nextPhase` не из `VALID_TRANSITIONS[current]`, `canTransition` возвращает false и оркестратор **молча останавливается**. Был пойман в ideation.ts → architecture (должно было быть specification). Skill `autonomous-dev-phase-transition-bug` задокументировал фикс.

### 3.1 Super-lead agent-team layer (v1.1)

v1.1 добавляет **opt-in lead-driven режим** поверх существующего 12-фазного waterfall. Таблица выше (single-query handlers) остаётся source-of-truth поведения по умолчанию — super-lead **не заменяет** её, а включается отдельным флагом для 4 decision-bearing фаз.

**Опт-ин:** `AUTONOMOUS_DEV_LEAD_DRIVEN=1` env var. При отсутствии или `=0` фазы идут старыми single-query путями (back-compat).

**Мигрированные фазы (4 из 12):**

| Фаза | Lead-роль | Специалисты | Контракт |
|------|-----------|-------------|----------|
| `specification` | product-manager-class | `nfr-analyst`, `out-of-scope-guard` | `src/orchestrator/phase-contracts/specification.contract.ts` |
| `architecture` | architect-class | `security-reviewer`, `scalability-reviewer` | `src/orchestrator/phase-contracts/architecture.contract.ts` |
| `testing` | qa-lead | `edge-case-finder`, `property-tester` | `src/orchestrator/phase-contracts/testing.contract.ts` |
| `review` | reviewer-lead | `security-auditor`, `accessibility-auditor` | `src/orchestrator/phase-contracts/review.contract.ts` |

**Примитив (`src/orchestrator/lead-driven-phase.ts`):**
- `runLeadDrivenPhase(opts)` — принимает типизированный `PhaseContract<TResult>` и выполняет полный цикл: build specialists → render lead prompt → consumeQuery → parse envelope → applyResult.
- `PhaseContract` (`src/orchestrator/phase-contract.ts`): `phase`, `goals`, `deliverables`, `allowedNextPhases`, `outputSchema` (Zod), `specialistNames`, `contextSelector`, `costCapUsd?`, `maxBackloopsFromHere?`.
- `PhaseBudgetGuard` — вложенный phase-level `Interrupter` внутри run-level signal. Cost cap фазы аbort'ит **только** фазу; SIGINT/budget на уровне run по-прежнему роняет весь оркестратор. Противоположное направление не работает — корректная вложенность.
- Валидация envelope: `success` boolean, `nextPhase ∈ allowedNextPhases`, `domain` парсится `outputSchema.safeParse()`.

**Защитные инварианты:**
- Specialists всегда получают `tools` **без** `Agent` (`sanitizeSpecialistTools` в примитиве) — не могут спавнить своих координаторов. Invariant скопирован из `development-runner.ts` (строки 1042-1044).
- `factory.ts` и `development-runner.ts` исключают имена phase-specialists из domain-agent match'инга (`PHASE_SPECIALIST_NAMES`), чтобы статический security-reviewer не был выбран на доменную задачу.

**Backloop + livelock семантика:**
- `state.phaseAttempts: Record<Phase, PhaseResultSummary[]>` — append-only история, включая каждый backloop re-entry. Существующий `state.phaseResults` сохраняет прежнюю "latest attempt" форму (back-compat).
- `state.backloopCounts: Record<`${from}->${to}`, number>` — per-pair счётчик. `incrementBackloopCount`/`isBackloopUnderCap` экспортируются из `src/orchestrator.ts`.
- **Livelock guard:** `GLOBAL_MAX_BACKLOOPS = 5` в оркестраторе. При попытке 6-го backloop'а одной пары `(from→to)` state persist'ится, run останавливается с `[orchestrator] backloop_livelock_guard: ...` логом.
- Per-contract cap'ы тон шее: `testing.contract.ts` и `review.contract.ts` оба задают `maxBackloopsFromHere: { development: 3 }`.

**Миграция state.json:** `phaseAttempts` и `backloopCounts` имеют `.catch({})` в `ProjectStateSchema` (`src/types/llm-schemas.ts`), поэтому pre-v1.1 state.json читается прозрачно — новые поля заполняются `{}`.

**Не мигрированы (осознанно, v1.2+):**
- `ideation.ts` — кастомный параллельный `analyzeDomain` + spec flow; нет очевидных специалистов; low value / high risk.
- `development-runner.ts` — уже agent-team shaped (из него и скопирован паттерн); рефактор был бы косметическим.
- Остальные (environment-setup, deployment/staging/production, ab-testing, analysis, monitoring) — остаются single-query до накопления evidence, что teams дают ROI.

**Cross-ref:** specialists — `src/agents/phase-specialist-blueprints.ts` (8 handwritten blueprints, регистрируются через `AgentRegistry.load()` и backfill'ятся в существующие registries). Тесты — `tests/orchestrator/lead-driven-phase.test.ts`, `tests/orchestrator/{architecture,review-testing,specification}-lead-driven.test.ts`, `tests/state/phase-attempts.test.ts`, `tests/integration/backloop-e2e.test.ts`.

---

## 4. Агентная система

### Базовые агенты (`src/agents/base-blueprints.ts`, 7 штук, всегда в команде)

`product-manager`, `architect`, `developer`, `qa-engineer`, `reviewer`, `devops`, `analytics`.

### Domain-agents — динамические

`src/agents/domain-analyzer.ts::analyzeDomain()` классифицирует идею → возвращает `DomainAnalysis` с `classification`, `specializations[]`, `requiredRoles[]`, `requiredMcpServers[]`, `techStack[]`.

`src/agents/factory.ts::buildAgentTeam()` идемпотентно:
1. Загружает `AgentRegistry` из `stateDir`.
2. Если domain-агенты уже есть (filter по `!baseNames.has(name)`) — возвращает как есть.
3. Иначе: `generateDomainAgents(idea, domain, config)` генерирует `AgentBlueprint[]` с `name`, `role`, `systemPrompt`, `tools`, `mcpServers`, `evaluationCriteria`.
4. `registry.register()` → persist в `.autonomous-dev/agents/{name}.v{n}.md` + `index.json`.

### Матчинг агент↔задача (в development-runner)

Substring-поиск по `task.title`:
```
titleLower.includes(bp.name.toLowerCase()) ||
titleLower.includes(bp.role.toLowerCase())
```

**Known weakness:** fragile. Например, `T-026 Chat service with RAG` не сматчит `llm-integration-specialist`. План фикса — добавить `keywords[]` в domain blueprints (см. `tasks-plans/tasks.md`, пункт 3).

### Codex-backed subagents (опциональный runtime)

`config.codexSubagents.enabled = true` → `src/agents/codex-proxy.ts` оборачивает subagent'ов так, что Opus остаётся team lead (оркестрирует), а реальная implementation делегируется в `codex exec` на `gpt-5.4` с `xhigh` reasoning.

**Fail-closed preflight** (`src/runtime/codex-preflight.ts`): при enabled=true на старте run'а пробует `codex --version`. Если бинарь не найден — бросает `UnsupportedTeamRuntimeError` (не силентная дeградация в дорогой proxy-loop). Пропускается во время `nightly` run'ов через `NIGHTLY_ENV_FLAG`.

---

## 5. Self-Improvement Loop

Модуль: `src/self-improve/` (8 файлов).

### Hill-climbing (`optimizer-runner.ts`)

```
baseline = runAllBenchmarks()
for i in 1..maxIterations:
    target = worstPerformer() || roundRobin()
    mutation = generateMutations(target, type = types[i % 4])
    applyInWorktreeSandbox(mutation)
    newScore = runAllBenchmarks()
    if newScore > baseline:
        accept(mutation) → savePromptVersion()
        baseline = newScore
    else:
        rollback(mutation)
    if converged(windowSize, minImprovement, maxStagnant):
        break
```

### Мутации (`mutation-engine.ts`)

| Тип | Что меняет |
|-----|-----------|
| `agent_prompt` | Системный промпт агента. Хирургические правки под конкретные слабости. Highest ROI. |
| `tool_config` | Набор `tools[]` в blueprint. |
| `phase_logic` | `maxTurns` (3–30), `model` (opus/sonnet/haiku). |
| `quality_threshold` | Пороги rubric-критериев. |

Выбор типа: **weighted selection** по истории последних 20 мутаций (`selectMutationType(history)`) — не простой round-robin. Типы, которые давали успешные accept'ы, получают бóльший вес.

### Бенчмарки (`benchmarks.ts` + `benchmark-defaults.ts`)

5 бенчмарков со взвешенным scoring:

| id | verifier | weight |
|----|----------|--------|
| `code-quality` | LLM-judge | 0.30 |
| `test-generation` | LLM-judge | 0.25 |
| `spec-completeness` | LLM-judge | 0.20 |
| `architecture-quality` | LLM-judge | 0.15 |
| `build-success` | deterministic | 0.10 |

Внешние задачи — в `benchmarks/<category>/tasks.json` (опционально, дефолты из `benchmark-defaults.ts`). Верификаторы (`verifiers.ts`): deterministic (exit-code, pytest/tsc, build success) + LLM-judge (0.0–1.0).

**Known weakness:** 4 из 5 бенчмарков на LLM-judge → шум в small deltas, hill-climbing может принять случайное колебание за прогресс. План — приоритизировать deterministic.

### Sandbox (`sandbox.ts`)

Каждая мутация исполняется в отдельном git worktree. Cleanup в `finally`. Таймаут через `AbortSignal.timeout(timeoutMs)`. **Известная security-дыра** (tasks.md): `runCommandInSandbox` принимает произвольную строку без executable allowlist — фикс в бэклоге.

### Версионирование (`versioning.ts`)

Принятые мутации → `{agentName}.v{N}.md` + запись в `state.evolution[]` с diff и old/new scores.

### Когда запускается

- **Ручной вызов** `autonomous-dev optimize --max-iterations 10`.
- **Ночной cron** `autonomous-dev nightly` — unattended full optimization.
- **Автоматически в pipeline — НЕ запускается.** Это архитектурное решение (не оптимизируй без спроса). Известный пробел: если optimizer автоматически срабатывал бы после `testing` при failures → был бы полный feedback loop. В бэклоге.

---

## 6. Stack Researcher и Environment Setup

Stack Researcher — агентный модуль (живёт в `src/agents/stack-researcher.ts`, не в `environment/`), который фаза `environment-setup` (`src/phases/environment-setup.ts`) вызывает для discovery. Оркестрация — пять параллельных шагов через `Promise.allSettled` (non-critical failures не блокируют фазу):

| Модуль | Что делает | Источники |
|--------|-----------|-----------|
| `src/environment/lsp-manager.ts` | LSP discovery per language (`pyright`, `vtsls`, `rust-analyzer`, ...) | Piebald-AI marketplace, npm, `claude plugin install` |
| `src/environment/mcp-manager.ts` | MCP discovery + config в `.mcp.json`. Приоритизация: official > community. Блок `--eval`/`-e`/`-c`/`--require` в args. | MCPcat.io, Smithery, npm, GitHub |
| `src/environment/plugin-manager.ts` | Claude plugins + skills per stack. | Claude plugin marketplaces |
| `src/environment/oss-scanner.ts` | Scan OSS repos (agents/skills/hooks/MCP/patterns), LLM-judge для полезности. | GitHub |
| `src/environment/claude-md-generator.ts` | Генерирует project-level `CLAUDE.md` со stack-specific conventions. | spec + architecture + domain |

### Примеры по стеку

- **Next.js + Prisma + Postgres** → `vtsls` + MCP: playwright, postgres, prisma-mcp + nextjs-best-practices skill.
- **Python + FastAPI + ML** → `pyright` + `ruff-lsp` + MCP: postgres, jupyter-mcp, mlflow-mcp + python-testing skill.
- **Rust + Actix-web** → `rust-analyzer` + MCP: postgres, docker-mcp + rust-patterns skill.

### Validation перед install (`validator.ts`)

Compatibility check → security scan (нет credential-access, нет network exfiltration) → benchmark до/после (если self-improve loop активен) → откат если score падает.

### Когда вызывается повторно

Не одноразовая операция:
- Стартовый run после `architecture`.
- При добавлении новой технологии в спеку.
- Из self-improve loop при обнаружении неэффективности агентов (много grep → не настроен LSP).

---

## 7. Наблюдаемость

### EventBus (`src/events/event-bus.ts`)

In-memory typed pub/sub. Типы событий и их data-интерфейсы:

| Тип | Когда | Data interface |
|-----|-------|----------------|
| `orchestrator.phase.start` / `.end` | Границы фазы | `OrchestratorPhaseStartData` / `EndData` (`durationMs`, `costUsd`, `success`) |
| `orchestrator.interrupt` | SIGINT / graceful shutdown | `OrchestratorInterruptData` (`reason`) |
| `agent.query.start` / `.end` | LLM-запрос агента | `AgentQueryStartData` / `EndData` (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `cost`, `model`, `durationMs`) |
| `agent.tool.use` / `.result` | Tool-call и результат | `AgentToolUseData` / `ToolResultData` (`tool`, `durationMs`, `success`) |
| `evaluation.rubric.start` / `.end` | Rubric evaluation | `EvaluationRubricStartData` / `EndData` (`phase`, `verdict`, `overallScore`) |
| `memory.capture` / `.recall` | Запись/чтение из MemoryStore | `MemoryCaptureData` / `RecallData` (`topic`, `phase`, `count`) |
| `session.state` | Изменение состояния сессии | `SessionStateData` (`status: waiting_for_confirmation`, ...) |

`Interrupter.reset()` — метод, который сбрасывает состояние (используется в тестах и при re-run'ах).

### EventLogger (`src/events/event-logger.ts`)

Подписан на `eventBus.onAll()`. Пишет JSONL: `.autonomous-dev/events/{runId}.jsonl`. Каждая строка: `{type, timestamp, seq, data}`. `generateRunSummary()` агрегирует totalTokens, totalCostUsd, per-phase breakdown, tool usage. Параллельно пишет сжатый `{runId}.summary.json` для dashboard.

### Dashboard (`src/dashboard/generate.ts`)

`autonomous-dev` в конце run'а (и по `nightly`) генерирует `.autonomous-dev/dashboard.html` — статический HTML из state + event-log. Показывает: фазы, агенты, costs, evolution entries. **Не real-time** — снимок на момент генерации.

### Run Ledger (`src/state/run-ledger.ts`)

Форензика spend и топологии. **7 session types** (`SessionType` в `run-ledger.ts`): `coordinator`, `team_lead`, `child_agent`, `subagent`, `rubric`, `memory`, `retry`. Классификация через `inferSessionType(agentName)`. Каждая запись: `{sessionId, parentId, role, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd, reasonCode?}`.

**Reason codes — унифицированы** через `src/types/failure-codes.ts::CanonicalFailureReasonCode` (superset обоих модулей; RunLedger и SpendGovernor используют общий alias):

```
provider_limit | provider_rate_limit | invalid_structured_output |
verification_failed | blocked_filesystem | unsupported_team_runtime |
transient | timeout | unknown
```

`TaskReceipt.failureReasonCode` отдельно — open-ended (`z.union([enum, z.string()])`) для forward-compatibility: LLM может вернуть emergent reason, не ломая парсинг.

### Interrupter (`src/events/interrupter.ts`)

Каждый `runOrchestrator()` создаёт свой `Interrupter`. SIGINT → `getInterrupter().interrupt(reason)`. Оркестратор проверяет `interrupter.isInterrupted()` в начале каждой итерации и делает graceful shutdown с `saveState`.

---

## 8. Память: L0/L2/L3/L4 LayeredMemory + SkillStore + MemoryStore

Иерархия памяти (PR #12/#13, Apr 17). **L1 слой удалён** как dead code (был interface + реализация в `layers.ts`, но ни одного потребителя; удалён вместе с двумя тестами).

| Слой | Модуль | Продюсер | Потребитель | Что хранит | Где |
|------|--------|----------|-------------|------------|-----|
| **L0** Meta-rules | `src/memory/layers.ts` + `meta-rules.json` | seed (bootstrap) | orchestrator (injection в system prompts) | Hard guardrails (coding standards, «never commit secrets», «always wrap user input»). | `src/memory/meta-rules.json` (in-repo) |
| **L2** Global facts | `src/memory/layers.ts` | stack-researcher (через `upsertFact()`) | **Пока нет активных** — факты сохраняются, но не инжектятся в промпты фаз (TODO) | Stack environment facts (`stack.lsp`, `stack.mcp`, `stack.domain`, `stack.tech`). Персистентно между run'ами. | `.autonomous-dev/memory/l2-facts.json` |
| **L3** Skill playbooks | `src/memory/skills.ts` (`SkillStore`) | dev-runner через `crystallize()` после успешного `TaskReceipt` | dev-runner через `findMatching()` + `recordUse()` на строке `development-runner.ts:~724` | Reusable task patterns. `TaskSignature` = `{domain, phase, titleKeywords[]}`. Матчинг через `toDomainSlug()` + keyword overlap. | `.autonomous-dev/memory/skills/{id}.json` |
| **L4** Session archive | `src/memory/layers.ts` | orchestrator в `finally` блоке run'а (не per-phase) | ручной recall | Краткие summaries завершённых run'ов (`runId`, `phases`, `totalCostUsd`, `completedAt`). | `.autonomous-dev/memory/session-archive.jsonl` |

### MemoryStore (`src/state/memory-store.ts`)

Стандартный cross-session knowledge store. Директория `.autonomous-dev/memory/`, индекс `_index.json`, документы `{id}.json`, история `history/{id}.jsonl`. Дефолтные лимиты: 500 документов, 100 KB/документ. **Eviction — FIFO по `updatedAt`** (не TTL с expiry-временем; это упрощение, true TTL — в бэклоге).

**Использование:**
- Перед каждой фазой: `memoryStore.search(phase, { limit: 5 })` → инжект релевантных знаний в prompt.
- После фазы: `capturePhaseMemories()` (`src/hooks/memory-capture.ts`) извлекает learnings.
- Rubric feedback: `memoryStore.write("rubric-feedback-{phase}", ...)` для обучения из прошлых ошибок.

**Known issues (в бэклоге):**
- ReDoS: `new RegExp(topicPattern, "i")` из caller input → нужна валидация длины/символов.
- O(n) search — не проблема до ~1k документов.

### SkillStore (`src/memory/skills.ts`)

Крысталлизация успешных task receipts в reusable skills.
- `extractSignature(taskTitle, domain, phase)` → `TaskSignature`.
- `toDomainSlug(raw)` → stable kebab-case slug, "generic" для пустых.
- `matchSkill(signature)` → keyword overlap score.
- При match → skill playbook инжектится в prompt следующей задачи с похожей сигнатурой.

---

## 9. Rubric Evaluation (структурированная оценка качества фаз)

Модуль: `src/evaluation/` (4 файла).

### Per-phase rubrics (`phase-rubrics.ts`)

**Development** (5 критериев):
| Критерий | Вес | Порог |
|----------|-----|-------|
| `compiles_cleanly` | 0.25 | 0.8 |
| `tests_exist_and_pass` | 0.25 | 0.7 |
| `no_security_issues` | 0.20 | 0.8 |
| `follows_architecture` | 0.15 | 0.7 |
| `acceptance_criteria_met` | 0.15 | 0.7 |

**Testing** (4): `adequate_coverage` 0.30/0.7, `edge_cases_covered` 0.25/0.6, `error_handling_tested` 0.25/0.6, `no_flaky_patterns` 0.20/0.8.

**Review** (4): `all_files_reviewed` 0.25/0.8, `security_issues_flagged` 0.30/0.7, `performance_checked` 0.20/0.6, `specific_line_references` 0.25/0.7.

### Grader (`grader.ts`)

Использует structured output (Zod): `RubricResultSchema` с `criteria[]`, `overallScore`, `verdict`. Verdicts: `satisfied` (все ≥ порогу) / `needs_revision` (некоторые ниже) / `failed` (>50% ниже).

**Profile-gated:** rubric evaluation включается через `config.rubric.enabled` — отключена по умолчанию для экономии стоимости. Включение даёт единственный путь для семантической проверки `acceptance_criteria_met` (quality gate покрывает только детерминированные checks).

### Evaluate-loop (`evaluate-loop.ts`)

Если `verdict === "needs_revision"` и осталось `maxRetries` — перезапуск фазы с feedback'ом в prompt. При `failed` — escalation в ledger (`reason_code: verification_failed`).

---

## 10. Hooks, Quality Gates и Security

Модуль: `src/hooks/` (7 файлов).

**6 хуков как `HookCallback` (SDK) + 1 функция-helper.** `memory-capture` технически — не hook, а функция, вызываемая напрямую из `orchestrator.ts` после каждой фазы (не через SDK hook-систему).

| Модуль | Триггер | Задача |
|--------|---------|--------|
| `hooks/quality-gate.ts` | `TaskCompleted` | `runQualityChecks()` — lint только (tsc + vitest живут в `runQualityChecks()` внутри development-runner, не в этом хуке). При провале — advisory. |
| `hooks/security.ts` | `PreToolUse` | Deny-list (rm -rf, sudo, curl \| sh, path-traversal, credential paths). **Known gap** — покрывает только Bash/Read/Write/Edit; Glob/Grep/Agent/WebFetch обходят (в бэклоге). |
| `hooks/idle-handler.ts` | `TeammateIdle` | Shutdown idle agents или переназначение. |
| `hooks/audit-logger.ts` | `PostToolUse` | Append-only JSONL `.autonomous-dev/audit/{runId}.jsonl`. |
| `hooks/notifications.ts` | `Notification` | Slack/webhook при значимых событиях. |
| `hooks/improvement-tracker.ts` | `PostToolUse` | TTL-evicted metrics для self-optimizer (tool usage, retry counts, durations). |
| `hooks/memory-capture.ts` **(функция, не hook)** | Вызов из `orchestrator.ts` после успешной фазы | Извлекает learnings → пишет в `MemoryStore`. |

### Ask-user hook (`src/runtime/ask-user.ts`)

Mid-phase clarification gate. По умолчанию **выключен** (`config.interactive.allowAskUser = false`). Когда выключен — вопрос пишется в `.autonomous-dev/pending-questions.jsonl`. Когда включён — блокирует на TTY.

### Task Receipts (`src/types/task-receipt.ts`)

Phase 6 замены text-heuristic success: задача считается done только при структурированном receipt'е, валидируемом `TaskReceiptSchema.safeParse()`. Фактическая схема:

```
{
  taskId, taskTitle,
  teamMemberId, agentRole, model,
  sessionIds: string[],
  branchName?, commitSha?,
  changedFiles: string[],                    // просто пути, без {path, mode}
  verificationCommands: [{
    command, success, stdoutSnippet?, exitCode?
  }],
  status: "success" | "failed" | "blocked" | "partial",    // enum, не "outcome"
  failureReasonCode?: FailureReasonCode,     // open-ended union: enum или свободная строка
  freeformNotes?,                             // для debug; НЕ влияет на success
  startedAt, completedAt
}
```

Персистится в `.autonomous-dev/receipts/{runId}/{taskId}.json`. Если `receipt.status !== "success"` — development-runner не помечает task как completed, даже если LLM ответил текстом «done». Freeform text можно приложить как `freeformNotes`, но он никогда не flip'ает status.

---

## 11. Governance: spend и retry

### SpendGovernor (`src/governance/spend-governor.ts`)

Per-phase и per-role spend caps + concurrency ceiling + retry policy.

Решения (`RetryDecision.action`):
- `allow` — продолжать.
- `stop` — остановить (budget exceeded / concurrency cap / identical-failure loop).
- `downgrade` — перейти на более дешёвую модель (opus → sonnet → haiku).
- `checkpoint` — сохранить state, пауза, ждать оператора.

Failure reasons: `provider_limit`, `verification_failed`, `transient`, `timeout`, `unknown`. Identical-failure detection через stable `signature` от FailureRecord — не даёт системе упираться в один и тот же баг.

### Retry с exponential backoff (`src/utils/retry.ts`)

Retry только при retryable errors: rate limits, overload, network. Fatal errors (validation, auth) — сразу проброс. Максимум 3 попытки по умолчанию.

### Budget cap на run

`--budget <usd>` в CLI → оркестратор проверяет `state.totalCostUsd` перед каждой фазой. При приближении к 80% — warning. При 100% — graceful stop через Interrupter.

**Known gap:** `totalCostUsd` обновляется только после `result.success`. Если фаза прервана — cost текущей фазы **теряется**. Fix в `development-runner.ts` — писать cost после каждого батча в `saveState` (в бэклоге).

---

## 12. Runtime: execution envelope

Phase 7: **валидированный runtime-контекст** для каждой делегированной задачи (`src/runtime/execution-envelope.ts`). Envelope — не agent-config, а **environment config**: агенты не тратят токены на детекцию путей, package manager'а и ветки.

`buildEnvelope()` формирует `ExecutionEnvelope`:

```
{
  projectRoot: абсолютный путь (fs-verified),
  writableRoot: абсолютный путь (может равняться projectRoot),
  branch: текущая git-ветка или null (вне git),
  packageRoot?: под-директория при monorepo,
  allowedVerificationCommands: string[] (whitelist команд),
  environment: { nodeVersion, packageManager: "npm"|"pnpm"|"yarn"|"bun"|"unknown", os }
}
```

`detectPackageManager(projectRoot)` — lockfile-based detection: bun > pnpm > yarn > npm. `renderEnvelopeBlock(envelope)` форматирует envelope в XML-блок, который inline-вставляется в task-prompt. Оркестратор передаёт envelope в каждый delegated task, гарантируя consistency между run'ами.

---

## 13. CLI и конфиг

### Команды и флаги

`run` команда (`src/index.ts`):

| Флаг | Что делает |
|------|------------|
| `--idea "..."` | Идея продукта (required). |
| `--config <path>` | Путь к `.autonomous-dev/config.json`. |
| `--resume <sessionId>` | Resume из checkpoint. |
| `--budget <usd>` | Cap на total cost (graceful stop через Interrupter при превышении). |
| `--dry-run` | Preview phases + agents + cost estimate; не тратит credits. |
| `--quick` | Skip опциональных фаз: `environment-setup`, `review`, `ab-testing`, `monitoring`. |
| `--confirm-spec` | Pause после ideation для user approval. |
| `--verbose` | Detailed progress output в stdout. |
| `--enable-rubrics` | Включить rubric evaluation loop (off по умолчанию — для debug/offline). |
| `--auxiliary-profile <profile>` | Профиль для rubric/memory loops: `minimal` (default), `debug`, `nightly`. |

Прочие команды:

| Команда | Флаги | Что делает |
|---------|-------|------------|
| `status` | `--config` | Print текущего state. |
| `phase --name <phase>` | `--config`, `--stack <tech,...>` | Run одной фазы (требует prior state; `--stack` для override при environment-setup). |
| `optimize` | `--config`, `--benchmark <id>`, `--max-iterations <N>` | Self-improve loop. |
| `nightly` | `--config`, `--max-iterations <N>`, `--skip-optimize`, `--skip-dashboard` | Unattended nightly maintenance. |
| `dashboard` | `--config`, `--watch` | Generate/regenerate `.autonomous-dev/dashboard.html`. |

### Конфиг (`src/utils/config.ts`, валидация через Zod)

Файл `.autonomous-dev/config.json` или `--config <path>`. Ключевые поля:

```json
{
  "model": "claude-opus-4-7",
  "subagentModel": "claude-sonnet-4-6",
  "projectDir": ".",
  "stateDir": ".autonomous-dev",
  "budgetUsd": 10,
  "codexSubagents": {
    "enabled": false,
    "model": "gpt-5.4",
    "reasoningEffort": "xhigh",
    "sandbox": "workspace-write",
    "approvalPolicy": "on-request"
  },
  "selfImprove": { "enabled": true, "maxIterations": 50, "nightlyOptimize": false },
  "memory": {
    "enabled": true,
    "maxDocuments": 500,
    "maxDocumentSizeKb": 100,
    "layers": { "enabled": true }
  },
  "interactive": { "allowAskUser": false },
  "rubric": { "enabled": false },
  "maxTurns": { /* per-phase turn limits */ }
}
```

**maxTurns defaults:** development 30 (снижено с 60 — большинство задач ≤20 turns), testing 30, review 20, deployment 20, ideation/architecture 10, monitoring 10, decomposition 3.

### Env vars (все optional)

`GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `POSTHOG_API_KEY`. Anthropic auth — автоматически через Claude Code subscription (не нужен `ANTHROPIC_API_KEY`).

---

## 14. Структура проекта

```
autonomous-dev-system/
├── README.md                        ← пользовательская документация (install, CLI)
├── PRODUCT.md                       ← этот файл (vision + context)
├── src/
│   ├── index.ts                     CLI entrypoint (commander)
│   ├── orchestrator.ts              phase loop + retry + checkpoint
│   ├── phases/                      13 файлов — по одному на фазу + types + dev-runner/dev-types
│   ├── agents/                      factory, registry (с performanceHistory), domain-analyzer, stack-researcher, codex-proxy, base-blueprints
│   ├── environment/                 lsp-manager, mcp-manager, plugin-manager, oss-scanner, claude-md-generator, validator
│   ├── self-improve/                optimizer, optimizer-runner, mutation-engine, benchmarks, benchmark-types, benchmark-defaults, benchmark-fixtures, sandbox, verifiers, convergence, versioning
│   ├── evaluation/                  rubric, phase-rubrics, grader, evaluate-loop
│   ├── events/                      event-bus, event-logger, interrupter
│   ├── hooks/                       6 хуков + memory-capture (функция): quality-gate, security, idle-handler, audit-logger, notifications, improvement-tracker, memory-capture
│   ├── state/                       project-state, session-store, memory-store, memory-types, run-ledger
│   ├── memory/                      layers (L0/L2/L4), skills (L3), meta-rules.json
│   ├── governance/                  spend-governor
│   ├── runtime/                     ask-user, codex-preflight, execution-envelope
│   ├── nightly/                     nightly-runner
│   ├── dashboard/                   generate.ts + template.ts (статический HTML)
│   ├── types/                       llm-schemas, phases (+OPTIONAL_PHASES), skills, task-receipt, failure-codes (unified reason codes)
│   └── utils/                       shared, config, retry, sdk-helpers, progress, type-guards
├── tests/                           79 test-файлов, 778 тестов (vitest)
├── benchmarks/                      external benchmark definitions
│   ├── code-quality/tasks.json
│   ├── test-generation/tasks.json
│   ├── spec-completeness/tasks.json
│   ├── architecture-quality/tasks.json
│   └── domain-specific/README.md
├── tasks-plans/                     backlog (см. tasks.md, управляется /backlog skill)
├── .autonomous-dev/                 runtime state — НЕ в git
│   ├── state.json                   полное состояние run'а
│   ├── sessions.json                SDK session IDs per phase
│   ├── dashboard.html               сгенерированный дашборд
│   ├── agents/                      AgentRegistry + blueprint.v{N}.md файлы
│   ├── events/{runId}.jsonl         event log
│   ├── events/{runId}.summary.json  агрегированный summary для dashboard
│   ├── memory/                      L0/L2/L3/L4 + MemoryStore документы (L1 удалён)
│   ├── receipts/{runId}/            task receipts
│   ├── pending-questions.jsonl     ask-user gate journal (когда allowAskUser=false)
│   └── codex-proxy/                 артефакты codex-proxy вызовов (создаётся лениво)
├── .claude/
│   ├── settings.json                permissions (deny/ask/dontAsk) для Claude Code
│   └── CLAUDE.md                    project-level agent instructions
└── docs/archive/                    исторические ревью и планы (сохранены для контекста)
```

---

## 15. Инварианты и конвенции

### Runtime

- **ESM modules** (`"type": "module"`). Import paths с `.js`-расширением (TS резолвит).
- **Async I/O только.** `execFile` (promisified), никогда `execFileSync`. Исключение — `fs.*Sync` для small state files под `withStateLock`.
- **`query()` через `consumeQuery()` wrapper** (`src/utils/sdk-helpers.ts`). Возвращает `{result, cost, modelUsage, inputTokens, outputTokens, cacheTokens}`.
- **Hooks** — `HookCallback` type из SDK.
- **Permission mode** — `acceptEdits` для autonomous run'ов. Исторически был `bypassPermissions`, но блокировался под root → поменяли.

### Данные и валидация

- **Immutable state.** `addTask`, `updateTask`, `saveCheckpoint` возвращают новый state. Никаких мутаций.
- **JSON.parse — всегда через Zod `.safeParse()`.** Никогда `as T`. Канонические schemas в `src/types/llm-schemas.ts`.
- **User input sanitization.** Все user-derived данные оборачиваются `wrapUserInput(tag, content)` из `src/utils/shared.ts` (XML delimiters). Применять **везде**, включая `mutation-engine.ts` (в бэклоге).
- **JSON extraction** из LLM text → `extractFirstJson` из `shared.ts`. Не дублировать.
- **Error messages** — через `errMsg(err)` из `shared.ts`.
- **Structured output** — Zod schemas + SDK `outputFormat`. Применено в `testing`, `review`, `deployment`, `monitoring`, `development.decomposeTasks`. Fallback — text parsing через `extractFirstJson`.

### Безопасность

- **Path traversal guard.** `assertSafePath(stateDir)` в `project-state.ts` — абсолютные пути разрешены, относительные не должны выходить за `cwd`.
- **MCP config injection.** Args проверяются element-by-element против suspicious patterns (`--eval`, `-e`, `-c`, `--require`).
- **LSP install commands** — split on whitespace + executable allowlist (в бэклоге).
- **Sandbox command allowlist** (в бэклоге).

### Costs

- Каждый phase handler обязан вернуть `costUsd` в `PhaseResult`. Оркестратор аккумулирует в `state.totalCostUsd`.
- После каждого батча в development — `saveState` с обновлённым `totalCostUsd` (в бэклоге как fix).

---

## 16. Текущее состояние реализации (Apr 17, 2026)

### Что работает end-to-end

- 12-фазный pipeline с транзициями, checkpoint-recovery, SIGINT-safe shutdown, resume через `--resume`.
- Dynamic Agent Factory + Domain Analyzer (генерация specialized agents работает).
- Stack Researcher (LSP/MCP/plugin/OSS discovery).
- Self-Improvement loop с hill-climbing + sandbox + versioning.
- Structured output через Zod в testing/review/deployment/monitoring/task-decomposition.
- EventBus + EventLogger + Interrupter.
- Run Ledger (Phase 1), spend governor (Phase 4), task receipts (Phase 6), execution envelope (Phase 7).
- L0/L2/L3/L4 LayeredMemory + SkillStore + MemoryStore + memory-capture function.
- Codex-proxy с fail-closed preflight.
- Nightly runner + dashboard generator.
- Rubric evaluation (profile-gated).
- Ask-user hook (journal mode default).
- Unified `FailureReasonCode` (9 значений) через `src/types/failure-codes.ts`.
- `OPTIONAL_PHASES` (включая `environment-setup`) — единый источник в `src/types/phases.ts`; `--quick` пропускает все 4 опциональные фазы.
- **777 тестов** (vitest), 79 test-файлов, clean typecheck + lint.

### Открытые задачи (полный список — в `tasks-plans/tasks.md`)

**Critical / security:**
- SDK CVE GHSA-5474-4w2j-mq4c — downgrade `@anthropic-ai/claude-agent-sdk` до `0.2.90`.
- Sandbox executable allowlist.
- Prompt injection в `mutation-engine.ts` — apply `wrapUserInput` ко всем interpolated variables.
- Command injection в `lsp-manager.ts` — executable allowlist.
- Security hook coverage: Glob/Grep/Agent/WebFetch.
- ReDoS в `memory-store.ts` (topicPattern RegExp).
- Path traversal в state dirs.

**High priority:**
- Rubric feedback loop в orchestrator (вызов есть только условный).
- Grader overwriting LLM verdict.
- Stale Interrupter singleton (race при параллельных run'ах).
- Specification phase stub + circular import.
- Unverified blueprints в `optimizer-runner.ts`.
- Wire domain agents into task assignment (keywords-based matching).
- Remove API key from Config object (живёт только в `process.env`).

**Продуктовые пробелы:**
- Web UI / real-time dashboard — нет. Текущий dashboard — статический HTML.
- Real-time LLM output streaming в stdout — нет (см. архивное `docs/archive/VIBE-REVIEW.md`).
- `init` команда для guided setup — нет.
- A/B testing phase — частично концептуальна (PostHog integration не реальна).
- Deployment cloud provider integration — staging/production фазы есть, cloud deploy не полный.
- Template / starter support — всегда from-scratch из idea string.

### Архитектурные решения, зафиксированные в commits

- **Subagents > Agent Teams для MVP.** Дешевле по токенам. Native agent-teams рантайм — цель, но пока пропущен (plan `2026-04-10-agent-teams-native-execution-plan.md` закрыт на Phase 1/4/6/7/10; остальные фазы — в бэклоге).
- **Git worktrees для isolation.** Mutation sandbox и parallel dev agents.
- **Validate before install.** LSP/MCP/plugin — security + compatibility + benchmark check, откат при регрессии.
- **`dontAsk` вместо `bypassPermissions`.** `dontAsk` респектит `ask`-правила, `bypassPermissions` их обходит. `acceptEdits` в autonomous runs под root.
- **Three feedback loops:** product loop (metrics → hypothesis → experiment), meta loop (benchmark → mutation → accept/reject), environment loop (efficiency → discover tools → validate → install).

---

## 17. Источники и ссылки

- **Активный бэклог:** `tasks-plans/tasks.md`.
- **Agent instructions:** `.claude/CLAUDE.md`.
- **Исторические документы:**
  - `docs/archive/PLAN.md` — оригинальное видение (мостик от концепции к реализации).
  - `docs/archive/PRODUCT-REVIEW.md`, `docs/archive/VIBE-REVIEW.md` — PM/UX ревью от Apr 8.
  - `docs/archive/TODO.md` — старый трекер (заменён `tasks.md` + `PRODUCT.md`).
  - `docs/archive/audit-report-2026-04-08.md`, `docs/archive/typescript-audit-2026-04-09.md` — коде-аудиты.
  - `docs/archive/product-execution-flow.md`, `docs/archive/flow-analysis-recommendations.md`, `docs/archive/test-run-analysis.md` — разбор live-прогонов.
  - `docs/archive/2026-04-10-agent-teams-native-execution-plan.md` — план native team runtime (частично реализован).
  - `docs/archive/2026-04-10-telegram-oi-*.md` — E2E findings + frontend interface spec (reference-only).
  - `docs/archive/2026-04-10-autonomy-test-hardening.md` — test plan (выполнен).
- **Skills (меж-сессионные):** `.codex/skills/`, `~/.claude/projects/.../memory/MEMORY.md`.
- **External docs:** [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk), [Claude Code](https://claude.ai/code).

---

*Документ заменяет: `PLAN.md`, `PRODUCT-REVIEW.md`, `VIBE-REVIEW.md`, `TODO.md`, и разбросанные планы/анализы в `plans/`, `tasks-plans/` (кроме `tasks.md`), `docs/superpowers/plans/`. При значимых архитектурных изменениях обновляй этот файл — одно место, единый источник правды.*
