# Документ: Внутренний поток выполнения autonomous-dev-system

> Составлен по данным live-запуска от 09.04.2026  
> Директория проекта: `test-run-email-bot/`  
> Исходные данные: `.autonomous-dev/state.json`, `.autonomous-dev/events/*.jsonl`, `src/`

---

## 1. Обзор системы

**autonomous-dev-system** — многоагентная система автономной разработки, построенная на Claude Agent SDK. Принимает на вход текстовую идею продукта и самостоятельно проходит весь цикл от анализа до деплоя: генерирует спецификацию, проектирует архитектуру, создаёт специализированных агентов под домен, реализует код, тестирует и выкатывает.

### Идея, которую обрабатывала система

```
Local email chatbot powered by Gemma 4 LLM — Python app with FastAPI backend that connects
to IMAP/SMTP, reads and categorizes emails, drafts smart responses using locally-running
Gemma 4 model via Ollama. Includes web UI for chat interface and email management
```

### Полный pipeline фаз

Система определяет 12 фаз жизненного цикла (`ALL_PHASES` в `src/state/project-state.ts`):

```
ideation → specification → architecture → environment-setup → development →
testing → review → staging → ab-testing → analysis → production → monitoring
```

Фазы `environment-setup`, `review`, `ab-testing`, `monitoring` помечены как **опциональные** — в `quick`-режиме пропускаются.

### Ключевые принципы

- **Phase-based loop**: оркестратор (`src/orchestrator.ts`) крутит цикл `while` с MAX_ITERATIONS=100, вызывая обработчик текущей фазы до завершения
- **Claude Agent SDK `query()`**: каждая фаза делегирует работу LLM-агентам через `query()` из `@anthropic-ai/claude-agent-sdk`
- **Динамические агенты**: фабрика `buildAgentTeam()` анализирует домен и генерирует специализированные агент-блюпринты
- **Checkpoint recovery**: после каждой партии задач состояние сохраняется — система восстанавливается после сбоя
- **Self-improvement**: оптимизатор Hill Climbing мутирует системные промпты агентов и откатывает изменения при ухудшении

---

## 2. Пофазный поток выполнения

### Сводная таблица по событиям

| seq | Тип события | Временная метка (UTC) | Длительность | Стоимость |
|-----|-------------|----------------------|--------------|-----------|
| 0 | `orchestrator.phase.start` ideation | 2026-04-09T11:45:11.138Z | — | — |
| 1 | `orchestrator.phase.end` ideation | 2026-04-09T11:48:13.928Z | **3 мин 2.8 сек** (182 790 мс) | **$0.5254** |
| 2 | `orchestrator.phase.start` specification | 2026-04-09T11:48:13.929Z | — | — |
| 3 | `orchestrator.phase.end` specification | 2026-04-09T11:48:13.930Z | **1 мс** | $0 (pass-through) |
| 4 | `orchestrator.phase.start` architecture | 2026-04-09T11:48:13.930Z | — | — |
| 5 | `orchestrator.phase.end` architecture | 2026-04-09T11:58:25.316Z | **10 мин 11.4 сек** (611 386 мс) | **$1.3543** |
| 6 | `orchestrator.phase.start` environment-setup | 2026-04-09T11:58:25.317Z | — | — |
| 7 | `orchestrator.phase.start` development | 2026-04-09T11:58:25.318Z | (в процессе на момент снятия состояния) | — |

> **Итого зафиксированных затрат: $1.8797**  
> Фаза `development` была активна в момент сбора данных.

---

### Фаза 1: `ideation` (3 мин 2.8 сек, $0.5254)

**Что делает фаза** (`src/phases/ideation.ts`):

Одновременно (параллельно через `Promise`) запускает два процесса:

1. **Domain Analysis** — LLM-агент `analyzeDomain()` классифицирует домен проекта, определяет необходимые специализации, рекомендует MCP-серверы и технологии
2. **Spec Generation** — PM-агент (`product-manager`) генерирует полную спецификацию продукта с использованием `WebSearch`/`WebFetch` для исследования рынка

**Промпт spec-агента** (константа `SPEC_PROMPT` в `src/phases/ideation.ts`):

```
You are a Senior Product Manager creating a complete, investor-ready product specification.
Use WebSearch to research the market — find real competitors and industry benchmarks before writing.
Output a JSON object with: summary, targetAudience, competitiveAnalysis, mvpScope,
techStackRecommendation, userStories (≥5, each with ≥2 Given/When/Then criteria),
nonFunctionalRequirements (≥4).
```

Пользовательская идея оборачивается через `wrapUserInput("project-idea", ...)` для предотвращения prompt injection.

**Что вернул LLM (из `state.json`, поле `spec`):**

- **Резюме**: «Privacy-first local email assistant powered by Gemma 4 LLM running via Ollama — self-hosted Python/FastAPI application...»
- **12 User Stories** (US-001 — US-012): от подключения IMAP/SMTP до Docker-деплоя, у каждой 2-4 acceptance criteria в формате Given/When/Then
- **7 NFR**: Performance (<500ms из кэша, <15s AI inference), Security (Fernet AES-128, TLS 1.2+, sandboxed iframe), Privacy (zero telemetry), Scalability (100k emails), Observability (structlog), Reliability (exponential backoff), Compatibility (Gmail/Outlook/Fastmail)
- **Конкуренты** (из WebSearch): Inbox Zero (5k+ GitHub stars, не поддерживает generic IMAP), Aomail (cloud LLMs — нет privacy), Mail0/Zero Email (нет AI-фичей)
- **Целевая аудитория**: privacy-conscious технический специалист 25-45 лет, 8-16 GB RAM, знаком с Docker

**Результат domain analysis** (поле `spec.domain`):

```json
{
  "classification": "productivity/ai-email",
  "specializations": [
    "IMAP/SMTP protocols (RFC 3501, RFC 5321) — connection pooling, IDLE push, folder management",
    "MIME parsing — multipart messages, nested attachments, charset decoding",
    "Email threading — In-Reply-To/References header chain reconstruction",
    "LLM prompt engineering for email tasks — categorization prompts, tone control",
    "Ollama API integration — model lifecycle, streaming responses, context window management",
    "Credential encryption at rest — AES-256 keyring"
  ],
  "requiredRoles": [
    "Email Protocol Specialist — IMAP/SMTP edge cases, MIME tree traversal",
    "LLM Integration Specialist — Ollama orchestration, prompt template design"
  ],
  "requiredMcpServers": ["context7", "github"],
  "techStack": ["Python 3.11+", "FastAPI 0.115+", "SQLite 3.45+ with FTS5", "Ollama 0.6+", ...]
}
```

**Мутация состояния**: `state.spec` → заполнено; `state.currentPhase` → `"specification"`

---

### Фаза 2: `specification` (1 мс, $0)

**Что делает фаза** (обработчик в `src/orchestrator.ts`):

```typescript
specification: async (state, _config) => {
  console.log("[specification] Specification merged into ideation — passing through to architecture.");
  return { success: true, nextPhase: "architecture", state };
},
```

Фаза-заглушка: `specification` полностью поглощена `ideation`. Существует только для сохранения pipeline-семантики. Стоимость: ноль, время: 1 мс.

---

### Фаза 3: `architecture` (10 мин 11.4 сек, $1.3543)

**Что делает фаза** (`src/phases/architecture.ts`):

Параллельно:
1. Вызывает `buildAgentTeam()` — инициализирует агентную команду, включая генерацию domain-специфичных агентов
2. Запускает `architect`-агента с `WebSearch`/`WebFetch` для проверки актуальных версий технологий

**Промпт architect-агента** (константа `ARCH_PROMPT`):

```
You are a Principal Software Architect. Given a product specification, design the complete
technical architecture AND decompose work into developer-ready tasks.
Use WebSearch to verify current stable versions of the chosen technologies.
Output JSON: { techStack, components, apiContracts, databaseSchema, fileStructure, taskDecomposition }
```

В промпт включаются: JSON спецификации, domain classification, specializations, recommended tech из domain analysis.

**Что вернул LLM (из `state.json`, поле `architecture`):**

**Технологический стек** (22 технологии с точными версиями):

| Категория | Технология |
|-----------|-----------|
| Backend | Python 3.12+, FastAPI 0.135.x, Uvicorn 0.44.x |
| Database | SQLite 3.45+ WAL + FTS5, aiosqlite 0.22.x |
| Email | aioimaplib 2.0.x, aiosmtplib 5.1.x |
| LLM | Ollama 0.20.x, Gemma 4 E4B (4-bit quantized) |
| HTTP | httpx 0.28.x |
| Frontend | SvelteKit 2.55.x + Svelte 5.53.x, Vite 8.0.x, TailwindCSS 4.2.x |
| Testing | pytest 8.x + pytest-asyncio, Vitest 3.x |
| Security | cryptography 46.0.x (Fernet AES-128-CBC) |
| Logging | structlog 25.5.x |
| Package | uv (backend), pnpm 9.x (frontend) |

**24 компонента** (в виде строк — не объектов):

```
FastAPI Application Core: main.py entrypoint with CORS, static file serving
Database Layer: aiosqlite connection pool with WAL mode, migration runner, FTS5
Encryption Service: Fernet key generation/loading from env or file
Account Manager: CRUD for IMAP/SMTP account configs with encrypted credential storage
IMAP Service: Async IMAP connection pool, folder listing, UID-based incremental fetch, IDLE
MIME Parser: Email message parsing (multipart, charset decoding, quoted-printable)
Email Sync Engine: Incremental sync via UID tracking, bulk initial fetch, FTS5 indexing
SMTP Service: Async SMTP connection with TLS enforcement, email composition
Ollama Client: Async httpx client for Ollama REST API, health check, model listing
LLM Prompt Templates: Jinja2 templates for categorization, draft generation (3 tones)
Categorization Service: Background worker, batch categorization
Draft Generation Service: Context-aware reply drafting with tone selection
Chat Service: Email retrieval via FTS5, context window management (last 5 exchanges)
Health & Observability: /health endpoint, structlog middleware
API Router Layer: FastAPI routers for accounts, emails, folders, drafts, chat, health
... (24 всего)
```

**Декомпозиция на 32 задачи** (поле `architecture.taskDecomposition.tasks`):

```
T-001: Scaffold backend FastAPI project
T-002: Scaffold frontend SvelteKit project
T-003: Database schema, migration system, and connection manager
T-004: Encryption service for credential storage
T-005: Account management API with Pydantic schemas
T-006: IMAP connection and folder listing service
T-007: Email fetch service with MIME parsing
T-008: Email sync engine with FTS5 indexing
T-009: Email listing and detail API endpoints
T-010: Folder listing API endpoint
T-011 – T-015: Frontend pages (account setup, layout, email list, detail, folder sidebar)
T-016: SMTP connection and send service
T-017: Frontend — compose and reply editor
T-018: Ollama integration service
T-019: Health check API and frontend status indicator
T-020: LLM prompt templates for all AI features
T-021: AI categorization service with background worker
T-022: Category API endpoints and frontend badges with override
T-023: AI draft generation API endpoint
T-024: Frontend — draft generation UI panel
T-025: Email search service using FTS5
T-026: Chat service with RAG and conversation memory
T-027: Frontend — chat interface
T-028: Background email sync with configurable interval
T-029: Structured logging and request timing middleware
T-030: Docker and docker-compose deployment configuration
T-031: Backend integration test suite
T-032: Frontend component tests and E2E smoke test
```

Поле `assignedAgent` у каждой задачи = `"?"` — назначение агентов происходит в `development-runner.ts` в runtime, а не при декомпозиции.

**Мутация состояния**: `state.architecture` → заполнено; `state.agents` → пополнено 9 агентами; `state.currentPhase` → `"environment-setup"`

---

### Фаза 4: `environment-setup` (статус: запущена, ~0 мс до перехода)

По данным событий (seq=6, seq=7), фазы `environment-setup` и `development` запустились с разницей в 1 мс (11:58:25.317Z и 11:58:25.318Z). Это говорит о том, что `environment-setup` либо отработала мгновенно, либо выполняется асинхронно параллельно с `development`.

`src/phases/environment-setup.ts` отвечает за:
- Обнаружение LSP-серверов через `src/environment/lsp-manager.ts`
- Обнаружение и конфигурирование MCP-серверов через `src/environment/mcp-manager.ts`
- Обнаружение плагинов через `src/environment/plugin-manager.ts`
- Генерацию `CLAUDE.md` для проекта через `src/environment/claude-md-generator.ts`

Поле `state.environment = null` — результаты environment-setup не были сохранены в состояние (либо фаза не успела завершить, либо вернула `null`).

---

### Фаза 5: `development` (в процессе)

**Что делает фаза** (`src/phases/development-runner.ts`):

1. **Декомпозиция user stories** (если задач ещё нет): LLM-агент разбивает user stories из спецификации на implementation tasks через structured output (JSON Schema)

2. **Группировка в батчи**: `groupIntoBatches()` строит DAG зависимостей. Задачи без зависимостей друг от друга попадают в один батч и могут выполняться параллельно

3. **Инициализация команды**: `buildAgentTeam()` + `AgentRegistry` — загружает все агент-блюпринты (базовые + domain-специфичные)

4. **Выполнение батчей**: для каждого батча `buildBatchAgents()` создаёт агента под каждую задачу:
   - Если название задачи совпадает с именем domain-агента → использует domain-специфичный блюпринт
   - Иначе → `dev-{task-id}` с generic промптом

5. **Quality gate после каждого батча**: `runQualityChecks()` → при провале `autoFixQualityIssues()`

6. **Checkpoint после каждого батча**: состояние сохраняется, обеспечивая resume

---

## 3. Агентная система

### Базовые агенты (из `src/agents/base-blueprints.ts`)

Всегда присутствуют в команде, независимо от домена:

| Имя | Роль |
|-----|------|
| `product-manager` | Product Manager |
| `architect` | Software Architect |
| `developer` | Software Developer |
| `qa-engineer` | QA Engineer |
| `reviewer` | Code Reviewer |
| `devops` | DevOps Engineer |
| `analytics` | Analytics & A/B Testing Engineer |

### Domain-специфичные агенты (сгенерированы для этого проекта)

Обнаружены доменом `productivity/ai-email`, сгенерированы `generateDomainAgents()` в `src/agents/domain-analyzer.ts`:

#### `email-protocol-specialist`
- **Роль**: Email Protocol Specialist
- **Экспертиза**: IMAP4rev1 (RFC 3501), IMAP IDLE (RFC 2177), SMTP submission (RFC 6409), MIME RFC 2045-2049, email threading (In-Reply-To/References), charset normalization, Fernet AES-128-CBC credential encryption
- **Инструменты**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- **Ответственности**: async IMAP client (aioimaplib), MIME tree traversal, SMTP pipeline (aiosmtplib), email threading engine, credential manager (PBKDF2-HMAC-SHA256 + Fernet), connection health monitor
- **Жёсткие ограничения**: никогда не хранить plaintext пароли, enforced TLS, IMAP FETCH только нужных частей (BODYSTRUCTURE + BODY[section]), всё I/O async, пул ≤3 соединений на аккаунт

#### `llm-integration-specialist`
- **Роль**: LLM Integration Specialist  
- **Экспертиза**: Ollama HTTP API (localhost:11434), Gemma 4 (8K/32K context, instruction format), prompt engineering, context window budget management, response quality evaluation
- **Инструменты**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- **Ответственности**: Ollama client service (httpx), Jinja2 prompt template system, email categorization pipeline, context-aware draft generation (SSE streaming), conversational chat handler, response quality guardrails
- **Жёсткие ограничения**: никогда не вызывать внешние AI API (OpenAI, Anthropic), Jinja2 autoescaping для всех LLM промптов, categorization только из определённой таксономии, connect/read timeouts (5s/60s)

### Как работает `buildAgentTeam()` (`src/agents/factory.ts`)

```
1. Инициализация AgentRegistry из stateDir
2. Проверка: есть ли уже domain-агенты? (filter by !baseNames.has(name))
   → если да: вернуть registry как есть (идемпотентно)
3. Получить domain из state.spec.domain (или вызвать analyzeDomain())
4. Если domain.requiredRoles.length > 0:
   → generateDomainAgents(idea, domain, config)
   → зарегистрировать и сохранить каждый агент через registry.register()
5. registry.save() → запись в .autonomous-dev/agents/
```

Агент-блюпринты сохраняются в `.autonomous-dev/agents/`:
- `email-protocol-specialist.v1.md`
- `llm-integration-specialist.v1.md`
- `developer.v1.md`, `architect.v1.md` и т.д.
- `index.json` — индекс всех блюпринтов

### Как domain-агенты используются в development

В `buildBatchAgents()` (`development-runner.ts`):

```typescript
const titleLower = task.title.toLowerCase();
const matchingDomain = domainAgents.find(
  (bp) =>
    titleLower.includes(bp.name.toLowerCase()) ||
    titleLower.includes(bp.role.toLowerCase())
);
```

Например, задача `T-006 IMAP connection and folder listing service` — содержит `imap` → совпадение с `email-protocol-specialist`. Задача `T-018 Ollama integration service` — содержит `llm` → совпадение с `llm-integration-specialist`.

---

## 4. Открытие инструментов и окружения

### Stack Researcher / Environment Setup

Модуль `src/phases/environment-setup.ts` оркестрирует:

**LSP Manager** (`src/environment/lsp-manager.ts`):
- Обнаруживает LSP-серверы для языков проекта
- Для Python: `pylsp`, `pyright`
- Для TypeScript: `typescript-language-server`

**MCP Manager** (`src/environment/mcp-manager.ts`):
- Domain analysis вернул рекомендации: `context7` (документация FastAPI/Ollama/aioimaplib), `github` (репозиторий)
- `configureMcpServers()` проверяет безопасность: блокирует флаги `--eval`, `-e`, `-c`, `--require` (arbitrary code execution)
- Сохраняет конфиг в `.mcp.json` проекта
- `getMcpServerConfigs()` возвращает конфиги для передачи в `query()` options

**Plugin Manager** (`src/environment/plugin-manager.ts`):
- Обнаруживает плагины IDE/редакторов

**OSS Scanner** (`src/environment/oss-scanner.ts`):
- Сканирует зависимости на известные уязвимости

**CLAUDE.md Generator** (`src/environment/claude-md-generator.ts`):
- Генерирует `CLAUDE.md` для проекта с контекстом стека и конвенций

**В данном прогоне**: `state.environment = null` — либо environment-setup не успела записать результаты до момента снятия снэпшота, либо завершилась с пропуском (quick mode).

---

## 5. Система самоулучшения (Self-Improvement)

Реализована в `src/self-improve/`. **В данном прогоне не активировалась** (`state.evolution = []`, `state.baselineScore = undefined`).

### Как работает Hill-Climbing оптимизатор

**`runOptimizerImpl()`** (`src/self-improve/optimizer-runner.ts`):

```
1. Установить baseline: runAllBenchmarks() → baselineScore
2. Loop (maxIterations):
   a. Выбрать целевого агента: worst performer по avgScore, fallback — round-robin
   b. Генерировать мутацию: generateMutations() из mutation-engine.ts
   c. Применить мутацию к агенту
   d. Запустить бенчмарки снова
   e. Если новый score > oldScore → принять мутацию (persist)
      Если нет → rollback (восстановить предыдущий промпт)
   f. Проверить конвергенцию: если улучшения < minImprovement за windowSize итераций → стоп
3. Сохранить evolution entry в state.evolution[]
```

### Типы мутаций (`src/self-improve/mutation-engine.ts`)

| Тип | Что изменяет |
|-----|-------------|
| `agent_prompt` | Системный промпт агента — хирургические правки по конкретным слабостям |
| `tool_config` | Набор инструментов агента — добавить/убрать инструменты |
| `phase_logic` | Параметры выполнения: `maxTurns` (3-30), `model` (opus/sonnet/haiku) |
| `quality_threshold` | Пороги качества для rubric-критериев |

Выбор типа мутации: равномерное чередование из массива типов по `iteration % types.length`.

### Мета-оптимизатор (промпты для мутаций)

Для `agent_prompt` мутации промпт:
```
You are a Meta-Optimizer. Given an agent's current system prompt and its benchmark performance,
generate an improved version. Make surgical changes targeting specific weaknesses.
Output the COMPLETE improved system prompt.
```

Для `tool_config`:
```
Given current tools and benchmark results, suggest tool changes.
Output a JSON array of tool names.
```

### Бенчмарки (`src/self-improve/benchmark-defaults.ts`)

Набор задач для оценки агентов. Каждый бенчмарк содержит `tasks[]` с `verifier` (deterministic или LLM-based).

- **Deterministic verifier**: проверяет вывод программно (regex, структурное сравнение)
- **LLM verifier**: «Rate the quality of the output on a scale of 0 to 1...»

### Конвергенция (`src/self-improve/convergence.ts`)

```
DEFAULT_CONVERGENCE = {
  windowSize: N,
  minImprovement: δ,
  maxStagnantIterations: K
}
→ converged если улучшение < δ за последние K итераций в окне windowSize
```

### Версионирование промптов (`src/self-improve/versioning.ts`)

Каждая принятая мутация сохраняется через `savePromptVersion()` — история изменений промптов агентов.

---

## 6. Качество и оценка (Rubric Evaluation)

Реализована в `src/evaluation/`. **В данном прогоне rubric evaluation не выполнялась** (в событиях нет `evaluation.rubric.start/end`).

### Как работает grader (`src/evaluation/grader.ts`)

После каждой фазы (если включено) оркестратор вызывает `gradePhaseOutput()`:

1. Получает рубрику для фазы через `getPhaseRubric(phase)` (`src/evaluation/phase-rubrics.ts`)
2. Строит промпт для LLM-grader:
   ```
   You are a quality grader. Evaluate the following phase output against a rubric.
   Criteria: [name, weight, threshold, description]
   Phase Output: [artifacts or error]
   → Score each criterion 0.0-1.0
   → verdict: "satisfied" | "needs_revision" | "failed"
   → overallScore = weighted average
   ```
3. Использует structured output (JSON Schema) для детерминированного парсинга ответа
4. Результат `RubricResult` прикрепляется к `PhaseResult`
5. Если MemoryStore включён → rubric feedback сохраняется для будущих сессий

### Рубрики по фазам

**Development rubric** (5 критериев):

| Критерий | Вес | Порог |
|----------|-----|-------|
| `compiles_cleanly` | 0.25 | 0.8 |
| `tests_exist_and_pass` | 0.25 | 0.7 |
| `no_security_issues` | 0.20 | 0.8 |
| `follows_architecture` | 0.15 | 0.7 |
| `acceptance_criteria_met` | 0.15 | 0.7 |

**Testing rubric** (4 критерия):

| Критерий | Вес | Порог |
|----------|-----|-------|
| `adequate_coverage` | 0.30 | 0.7 |
| `edge_cases_covered` | 0.25 | 0.6 |
| `error_handling_tested` | 0.25 | 0.6 |
| `no_flaky_patterns` | 0.20 | 0.8 |

**Review rubric** (4 критерия):

| Критерий | Вес | Порог |
|----------|-----|-------|
| `all_files_reviewed` | 0.25 | 0.8 |
| `security_issues_flagged` | 0.30 | 0.7 |
| `performance_checked` | 0.20 | 0.6 |
| `specific_line_references` | 0.25 | 0.7 |

Оценка `"satisfied"` — если ВСЕ критерии ≥ порогу. `"needs_revision"` — некоторые проваливаются. `"failed"` — больше половины проваливаются.

---

## 7. Система событий и наблюдаемость

### EventBus (`src/events/event-bus.ts`)

In-memory pub/sub система. Поддерживаемые типы событий:

| Тип | Когда эмитируется |
|-----|-------------------|
| `orchestrator.phase.start` | Начало каждой фазы |
| `orchestrator.phase.end` | Конец фазы (success, costUsd, durationMs) |
| `orchestrator.interrupt` | SIGINT / graceful shutdown |
| `agent.query.start` | Начало LLM-запроса агента |
| `agent.query.end` | Конец LLM-запроса (tokens, cost, duration) |
| `agent.tool.use` | Использование инструмента агентом |
| `agent.tool.result` | Результат инструмента (success, durationMs) |
| `evaluation.rubric.start/end` | Начало/конец rubric evaluation |
| `memory.capture` | Сохранение памяти из фазы |
| `memory.recall` | Извлечение памяти для фазы |
| `session.state` | Изменение состояния сессии |

### EventLogger (`src/events/event-logger.ts`)

Подписывается на все события через `eventBus.onAll()`. Пишет JSONL-файл:

```
.autonomous-dev/events/{runId}.jsonl
```

Каждая строка — JSON с полями `type`, `timestamp`, `seq`, `data`.

**Данные этого прогона**: файл `6674c09a-300c-4166-a50e-76722c51d5c7.jsonl`, 8 событий (seq 0-7).

`EventLogger.generateRunSummary()` агрегирует:
- totalTokens (input/output)
- totalCostUsd
- phases (name, durationMs, success, costUsd)
- toolUsage (count, totalDurationMs per tool)

### Interrupter (`src/events/interrupter.ts`)

Каждый `runOrchestrator()` создаёт собственный `Interrupter`. SIGINT-обработчик (`src/index.ts`) вызывает `getInterrupter().interrupt(reason)`. Оркестратор проверяет `interrupter.isInterrupted()` в начале каждой итерации и делает graceful shutdown.

---

## 8. Память и персистенция состояния

### ProjectState (`src/state/project-state.ts`)

Полное состояние сериализуется в:
```
.autonomous-dev/state.json
```

Ключевые поля состояния в этом прогоне:

```json
{
  "id": "e261a33b-f731-49cc-803b-c525c13bf03e",
  "idea": "Local email chatbot...",
  "currentPhase": "development",
  "completedPhases": null,
  "spec": { ...12 user stories, 7 NFRs, domain analysis... },
  "architecture": { ...22-tech stack, 24 components, 32 tasks... },
  "agents": [ ...9 agents... ],
  "tasks": [],
  "evolution": [],
  "environment": null,
  "totalCostUsd": null
}
```

`saveState()` вызывается после каждой фазы, после каждого батча, при graceful shutdown.

### PhaseCheckpoints

Хранятся в памяти `state.checkpoints[]`. После каждого батча в development:

```json
{
  "phase": "development",
  "completedTasks": ["task-001", "task-002", ...],
  "pendingTasks": ["task-003", ...],
  "timestamp": "2026-04-09T...",
  "metadata": { "batchIndex": 0, "totalCost": 0.45, "sessionIds": [...] }
}
```

### Resume механизм

При restart: `getLatestCheckpoint(state, "development")` находит последний чекпоинт. `development-runner.ts` фильтрует `completedIds` из `checkpoint.completedTasks` и продолжает с незавершённых задач.

### MemoryStore (`src/state/memory-store.ts`)

Если `config.memory.enabled = true` — персистентное хранилище знаний между сессиями:

- Директория: `.autonomous-dev/memory/`
- Индекс: `.autonomous-dev/memory/_index.json`
- Каждый документ: `.autonomous-dev/memory/{id}.json`
- История изменений: `.autonomous-dev/memory/history/{id}.jsonl`

Перед каждой фазой: `memoryStore.search(phase, { limit: 5 })` → инжектирует релевантные знания в промпт.
После фазы: `capturePhaseMemories()` извлекает и сохраняет ключевые выводы.
Rubric feedback → `memoryStore.write("rubric-feedback-{phase}", ...)` для обучения из прошлых ошибок.

Лимиты по умолчанию: 500 документов, 100 KB на документ.

**В данном прогоне**: MemoryStore не использовался (`config.memory` не настроен).

### Sessions (`src/state/session-store.ts`)

Хранятся в `.autonomous-dev/sessions.json`. SDK session ID per phase — обеспечивает возможность продолжения прерванного LLM-диалога.

---

## 9. Ключевые наблюдения

### Что отработало хорошо

1. **Параллельный domain analysis**: запускается одновременно со spec generation в ideation, экономя время. За 3 минуты получена полная спецификация + domain classification

2. **Качество spec**: 12 user stories с детальными acceptance criteria, 7 NFR, конкурентный анализ с реальными данными из WebSearch (Inbox Zero, Aomail, Mail0) — всё за $0.52

3. **Детальная архитектура**: за $1.35 получены 22 версионированные технологии, 24 компонента, 32 задачи декомпозиции — достаточно для реальной разработки

4. **Domain agents**: система правильно идентифицировала что email + LLM требует специализации и сгенерировала 2 качественных агента с конкретными RFC-ссылками и hard constraints

5. **Безопасность MCP**: блокировка опасных флагов (`--eval`, `-e`, `--require`) в MCP-конфигах

6. **Идемпотентность `buildAgentTeam()`**: повторный вызов не перегенерирует агентов

### Что не отработало / было пропущено

1. **`state.phaseResults` = пуст**: несмотря на то что события содержат `costUsd`/`durationMs`, поле `phaseResults` в state.json не заполнено. Метрики есть только в event log

2. **`state.completedPhases` = null**: фазы `ideation`, `specification`, `architecture` завершились успешно, но `completedPhases` не обновлялось

3. **`state.tasks` = []**: несмотря на декомпозицию в архитектуре (32 задачи в `architecture.taskDecomposition`), массив `state.tasks` остался пустым. Задачи регистрируются через `addTask()` только в `development-runner.ts`, который ещё не завершил инициализацию

4. **`environment` = null**: environment-setup не записала результаты

5. **MemoryStore не активен**: кросс-сессионная память отключена, rubric feedback не накапливается

6. **Self-improvement не запускался**: `evolution = []` — оптимизатор активируется только по явному вызову `runOptimizer()`, не является частью основного pipeline

7. **Rubric evaluation не выполнялась**: нет событий `evaluation.rubric.start/end` в log — по умолчанию отключена

8. **`components` в архитектуре — массив строк, а не объектов**: архитектурный промпт ожидал массив объектов, но LLM вернул плоские строки. Система приняла это без ошибки (нет strict schema enforcement на `components`)

### Рекомендации

1. **Заполнять `state.completedPhases` и `state.phaseResults`** в оркестраторе после каждой фазы для полной observability без разбора event log

2. **Включить MemoryStore по умолчанию** с небольшим лимитом — rubric feedback в памяти ускоряет обучение системы

3. **Rubric evaluation** стоит включить хотя бы для development и review фаз — это единственный механизм качественной обратной связи

4. **Строгая Zod-валидация `components`** — сейчас принимает строки там где ожидались объекты

5. **Task assignment при декомпозиции**: поле `assignedAgent = "?"` в архитектурных задачах — логика назначения существует только в development-runner. Можно заполнять на этапе архитектуры исходя из domain knowledge

---

## Приложения

### A. Дерево директорий `.autonomous-dev/`

```
.autonomous-dev/
├── state.json                    — полное состояние проекта
├── sessions.json                 — SDK session IDs per phase
├── dashboard.html                — HTML-дашборд (сгенерирован монитором)
├── agents/
│   ├── index.json                — индекс всех зарегистрированных агентов
│   ├── product-manager.v1.md
│   ├── architect.v1.md
│   ├── developer.v1.md
│   ├── qa-engineer.v1.md
│   ├── reviewer.v1.md
│   ├── devops.v1.md
│   ├── analytics.v1.md
│   ├── email-protocol-specialist.v1.md    ← domain-specific
│   └── llm-integration-specialist.v1.md   ← domain-specific
└── events/
    └── 6674c09a-300c-4166-a50e-76722c51d5c7.jsonl   — event log этого прогона
```

### B. Структура запроса через `query()` (Claude Agent SDK)

Каждая фаза вызывает агентов примерно так:

```typescript
const queryResult = await consumeQuery(
  query({
    prompt: `${ARCH_PROMPT}\n\n${wrapUserInput("product-spec", JSON.stringify(state.spec))}`,
    options: {
      tools: ["WebSearch", "WebFetch"],
      agents: baseAgentDefs,   // агент-блюпринты доступны как подагенты
      mcpServers: mcpConfigs,  // MCP серверы из environment-setup
      maxTurns: getMaxTurns(config, "architecture"),
      model: config.model,
    },
  }),
  "architecture"  // label для логирования
);
```

`consumeQuery()` (`src/utils/sdk-helpers.ts`) итерирует стрим сообщений SDK, собирает финальный `result` и суммарный `cost`.

---

*Документ составлен: 2026-04-09 | Данные актуальны на момент снятия состояния во время live-прогона*
