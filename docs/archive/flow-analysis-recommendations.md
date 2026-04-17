# Анализ и рекомендации по autonomous-dev-system

> Составлено на основе live-прогона от 09.04.2026, исходного кода и flow-документа.

---

## 1. Сводка анализа потока выполнения

### Что произошло в прогоне

Система обработала идею «local email chatbot on Gemma 4» и прошла следующие фазы:

| Фаза | Время | Стоимость | Статус |
|------|-------|-----------|--------|
| `ideation` | 3 мин 2.8 сек | $0.5254 | ✅ завершена |
| `specification` | 1 мс | $0 | ✅ pass-through |
| `architecture` | 10 мин 11.4 сек | $1.3543 | ✅ завершена |
| `environment-setup` | ~0 мс | — | ⚠️ пропущена / не записала результат |
| `development` | — | — | 🔄 в процессе на момент снэпшота |

**Итого зафиксировано**: $1.88, 8 событий в event log, фазы `testing`—`monitoring` не запущены.

### Ключевые результаты, которые система произвела

- **Spec**: 12 user stories с acceptance criteria, 7 NFR, конкурентный анализ (Inbox Zero, Aomail, Mail0) — всё через WebSearch. Качество неожиданно высокое для $0.52.
- **Architecture**: 22 технологии с версиями, 24 компонента, 32 задачи с DAG-зависимостями — достаточно для реальной разработки.
- **Domain agents**: 2 специализированных агента (`email-protocol-specialist`, `llm-integration-specialist`) с RFC-ссылками, hard constraints и конкретными ответственностями. Генерация сработала правильно.

### Критические наблюдения

1. `state.completedPhases = null` — 3 фазы завершились, но поле не обновлялось
2. `state.phaseResults = {}` — метрики (cost, duration) есть только в event log, не в state
3. `state.tasks = []` — 32 задачи из `architecture.taskDecomposition` не перенесены в state до старта development
4. `state.environment = null` — environment-setup не сохранила результаты
5. `state.totalCostUsd = null` — накопленная стоимость теряется до окончания всех фаз
6. Self-improvement, MemoryStore, rubric evaluation — все отключены, не являются частью основного pipeline

---

## 2. Анализ промптов

### SPEC_PROMPT (`src/phases/ideation.ts:10-69`)

**Структура**: 60 строк, детальный JSON-скаффолд с примерами значений. Инструктирует делать WebSearch перед написанием. Требования MoSCoW, количественные лимиты (≥5 user stories, ≥2 criteria each, ≥4 NFR).

**Что работает хорошо**:
- JSON-скаффолд с примерами — сильно снижает галлюцинации структуры
- `Output ONLY the JSON` — чистый парсинг без лишнего текста
- Конкретные количественные требования дают стабильный минимальный объём

**Проблемы**:

1. **`Output ONLY the JSON` убивает chain-of-thought**. LLM не может «думать вслух» перед структурированным ответом — качество рассуждений падает. Правильно: использовать `outputFormat` / structured output SDK-level, а промпт пусть разрешает thinking.

2. **Промпт не указывает на домен**. Идея пользователя инжектируется как `wrapUserInput("project-idea", ...)` после промпта, но в теле промпта нет инструкции «адаптируй spec к домену». LLM получил идею почти случайно — без явного «вот проект, под который нужно spec».

3. **`techStackRecommendation` в SPEC_PROMPT избыточен**. Это дублирует работу architect-агента. В реальности spec не должен диктовать стек — это создаёт конфликт между PM и architect.

4. **Нет инструкции про MVP-скоуп для конкретного домена**. «2-4 week build» — слишком общо. Для AI-heavy проекта с local LLM это нереалистично.

**Предложения по улучшению**:
```
// Добавить в начало после роли:
Think step by step before writing the JSON: (1) research competitors, (2) identify the 
core value prop, (3) scope MVP ruthlessly. Write your reasoning as <!-- thinking --> 
comments before the JSON block.

// Убрать techStackRecommendation из spec или переименовать в techConstraints:
"techConstraints": {
  "mustUse": ["must be self-hosted", "no cloud APIs"],
  "preferred": ["Python ecosystem for ML/AI", "..."]
}
```

---

### ARCH_PROMPT (`src/phases/architecture.ts:10-63`)

**Структура**: 55 строк, требует JSON с `techStack`, `components`, `apiContracts`, `databaseSchema`, `fileStructure`, `taskDecomposition`. Инструктирует WebSearch для версий.

**Проблемы**:

1. **`components` описан как массив строк, но нужны объекты**. Промпт пишет: `"Frontend: Next.js App Router..."` — одна строка. В результате `architecture.components` — это 24 плоские строки, не объекты с `name`, `description`, `owner`, `interfaces`. Zod не валидирует структуру → тихий регресс качества.

2. **`apiContracts` — строка, не schema**. `"OpenAPI 3.1 YAML or GraphQL SDL"` — это огромный документ, который LLM попытается уместить в одно строковое поле. Неработоспособно для любого нетривиального проекта.

3. **Нет инструкции про consistency с spec**. Architect не знает, что надо проверить: все ли `must` user stories покрыты задачами? Нет cross-reference между US-XXX и T-XXX.

4. **`taskDecomposition` ссылается на TypeScript как дефолт**, хотя пример — Next.js. Для Python-проекта (email bot) LLM игнорирует примеры стека в промпте — и это правильно, но пример сбивает с толку.

**Предложения**:
```
"components": [
  {
    "name": "ComponentName",
    "description": "What it does",
    "technology": "FastAPI",
    "owner": "backend-developer",
    "interfaces": ["POST /api/accounts", "GET /api/emails"]
  }
]

// Добавить требование трассируемости:
"Each task MUST reference at least one user story ID (US-XXX) in its description"

// apiContracts — разбить на sub-sections или вынести в отдельную фазу
```

---

### DEV_PROMPT (в `development-runner.ts`)

Задачи выполняются в батчах, каждый батч — отдельный `query()`. Агент получает:
- Контекст задачи (title, description, acceptanceCriteria)
- Полный state (spec + architecture)
- Domain agent blueprint как системный промпт

**Проблема**: задача из `architecture.taskDecomposition` содержит подробные acceptance criteria, но задача из `decomposeUserStories()` — нет. Если `architecture.taskDecomposition` уже есть в state, зачем перегенерировать задачи через `decomposeUserStories()`? Двойная декомпозиция тратит токены и теряет качественные acceptance criteria из архитектуры.

**Предложение**: `runDevelopment` должен в первую очередь использовать задачи из `architecture.taskDecomposition`, а `decomposeUserStories` вызывать только как fallback.

---

## 3. Анализ агентной системы

### Что работает

- **Domain analysis** точно определил специализации: IMAP/SMTP protocol expert и LLM integration specialist — правильный выбор для email+AI домена.
- **Идемпотентность `buildAgentTeam()`**: повторный вызов не перегенерирует агентов — корректная обработка resume.
- **Hard constraints в агентах**: `никогда не хранить plaintext пароли`, `enforced TLS`, `пул ≤3 соединений` — это реально влияет на качество генерируемого кода.
- **Версионирование блюпринтов** (`.v1.md`): готово к эволюции через self-improvement.

### Проблемы

**1. Матчинг агентов — хрупкий substring-поиск** (`development-runner.ts`):
```typescript
titleLower.includes(bp.name.toLowerCase()) ||
titleLower.includes(bp.role.toLowerCase())
```
Задача `"T-007: Email fetch service with MIME parsing"` — совпадёт ли с `email-protocol-specialist`? Только если `"email"` есть в title. Задача `"T-026: Chat service with RAG"` — не совпадёт с `llm-integration-specialist` (нет слова `llm`). Агент назначается неправильно → generic developer делает работу специалиста.

**Решение**: добавить в domain agents поле `keywords: string[]` и матчить по нему:
```typescript
bp.keywords.some(kw => titleLower.includes(kw))
// email-protocol-specialist keywords: ["imap", "smtp", "mime", "email", "fetch", "sync"]
// llm-integration-specialist keywords: ["ollama", "llm", "ai", "chat", "draft", "categoriz"]
```

**2. `assignedAgent = "?"` в architecture tasks**. Логика назначения агентов известна уже в момент декомпозиции — можно заполнять при генерации архитектуры. Сейчас это информация теряется и восстанавливается из substring-матчинга.

**3. Нет метрик качества по агентам**. Неизвестно, какие агенты производят лучший код. `evolution = []` — оптимизатор никогда не запускался. Без метрик self-improvement слеп.

**4. Base agents слишком генеричны**. `developer` агент — universal fallback. Для проекта на Python нет python-specific агента. После domain analysis мог бы добавиться `python-backend-developer` с FastAPI/asyncio знаниями.

---

## 4. Пробел в self-improvement

### Почему не активировалось

`runOptimizer` — **явный вызов**, не интегрирован в pipeline оркестратора (`src/orchestrator.ts`). В оркестраторе нет ни одного места, где он вызывался бы автоматически. Это архитектурное решение («не оптимизируй без спроса»), но в текущем состоянии self-improvement никогда не запустится в normal operation.

### Когда должен запускаться

Оптимизатор имеет смысл запускать:
1. **После `testing` фазы** — есть конкретные failure-данные; мутации агентов можно валидировать через повторный прогон тестов
2. **После `review` фазы** — reviewer выявил паттерны проблем → мета-оптимизатор знает, что конкретно улучшать
3. **Между сессиями** — как фоновый процесс, не блокирующий основной pipeline

### Что оптимизатор реально улучшит

Сейчас `mutation-engine.ts` знает 4 типа мутаций: `agent_prompt`, `tool_config`, `phase_logic`, `quality_threshold`. Наиболее ценные на практике:

- `agent_prompt` — единственная мутация с реальным ROI. Промпты агентов влияют на качество кода напрямую.
- `phase_logic` → изменение `maxTurns` — полезно для оптимизации стоимости.
- `tool_config` — низкий ROI, список инструментов и так специфичен per agent.

### Проблема с бенчмарками

`benchmark-defaults.ts` использует LLM-as-judge: «Rate the quality of the output on a scale of 0 to 1». Это нестабильно для малых дельт улучшений. Hill-climbing может принять случайный шум за прогресс.

**Рекомендация**: приоритизировать deterministic verifiers там, где возможно (TypeScript typecheck, pytest pass/fail, eslint --max-warnings 0). LLM-judge — только для семантического качества, где программная проверка невозможна.

### Условие запуска в pipeline

```typescript
// В orchestrator.ts, после phase "testing":
if (config.selfImprove?.autoRun && result.success) {
  const failedTestsCount = extractFailedTests(result);
  if (failedTestsCount > 0 || result.rubricResult?.verdict === "needs_revision") {
    await runOptimizer(state, config, { maxIterations: 5, targetPhase: "development" });
  }
}
```

---

## 5. Пробел в rubric evaluation

### Почему не выполнялась

`gradePhaseOutput` в `src/evaluation/grader.ts` реализована корректно — использует structured output (Zod), имеет fallback, логирует в EventBus. Но в `runOrchestrator` нет ни одного вызова этой функции. Rubric evaluation — dead code в production path.

### Что рубрики поймают, чего сейчас нет

Текущий quality gate в development — `runQualityChecks()` — это, по всей видимости, детерминированные проверки (typecheck, lint, tests). Рубрики добавляют семантический слой:

| Критерий | Почему важен |
|----------|-------------|
| `compiles_cleanly` (0.25) | Детерминировано — уже покрыто quality gate |
| `tests_exist_and_pass` (0.25) | Детерминировано — покрыто |
| `no_security_issues` (0.20) | **Не покрыто** — статический анализ есть только если OSS Scanner отработал |
| `follows_architecture` (0.15) | **Не покрыто** — LLM может отклониться от spec без проверки |
| `acceptance_criteria_met` (0.15) | **Не покрыто** — самое важное: соответствие user stories |

Ключевой ненакрытый случай: `acceptance_criteria_met`. Development агент может написать код, который компилируется и проходит тесты, но не делает того, что описано в user story. Рубрика поймает это; quality gate — нет.

### Включить по умолчанию

**Рекомендация**: включить rubric evaluation для `development` и `testing` фаз по умолчанию (не только когда `config.rubric?.enabled`). Стоимость одного rubric вызова — 1 `query()` с `maxTurns: 1` — вероятно $0.01-0.05. Это дешевле, чем ошибка, найденная на `review` или `production`.

Текущий fallback в grader при failed parse — `score: 0.5` для всех критериев — скрывает реальные проблемы. Нужен более консервативный fallback (например, `verdict: "needs_revision"` вместо принятия нейтральных оценок).

---

## 6. Проблемы управления состоянием

### Полная картина несоответствий в state.json

| Поле | Ожидалось | Фактически | Причина |
|------|-----------|------------|---------|
| `completedPhases` | `["ideation","specification","architecture"]` | `null` | Оркестратор не обновляет это поле |
| `phaseResults` | `{ideation: {costUsd, durationMs}, ...}` | `{}` | Результаты идут в EventLogger, не в state |
| `tasks` | 32 задачи из архитектуры | `[]` | `addTask()` вызывается только в `runDevelopment` |
| `totalCostUsd` | Нарастающий итог | `null` | Присваивается в цикле оркестратора, но не сохраняется в `saveState` промежуточно |
| `environment` | MCP configs, LSP servers | `null` | `environment-setup` не сохранила или выполнилась параллельно |

### Конкретные фиксы

**1. `completedPhases` — обновлять в оркестраторе:**
```typescript
// После result.success в runOrchestrator
state = {
  ...result.state,
  totalCostUsd,
  completedPhases: [...(state.completedPhases ?? []), phase],
  phaseResults: {
    ...state.phaseResults,
    [phase]: { costUsd: result.costUsd, durationMs: elapsedMs, success: true }
  }
};
```

**2. Задачи из архитектуры — импортировать при старте development:**
```typescript
// В начале runDevelopment, если tasks пустой:
if (updatedState.tasks.length === 0 && state.architecture?.taskDecomposition?.tasks) {
  for (const archTask of state.architecture.taskDecomposition.tasks) {
    updatedState = addTask(updatedState, archTask);
  }
}
// Пропустить decomposeUserStories — задачи уже есть
```

**3. `environment` — сохранять результат setup, даже если частичный:**
`environment-setup` должна писать в state сразу после каждого обнаруженного сервера, не только в конце фазы. Иначе прерывание = потеря всего.

**4. Что ещё стоит персистировать**:
- `state.agentMetrics: Record<agentName, {avgScore, callCount, lastUsed}>` — для приоритизации в self-improvement
- `state.rubricHistory: RubricResult[]` — история оценок для трендов
- `state.runHistory: {runId, startedAt, endedAt, totalCost, phasesCompleted}[]` — без разбора event logs

---

## 7. UX и developer experience

### Текущее состояние

Единственный интерфейс — консоль. Пользователь видит:
```
[progress] Phase 1/12: ideation ████░░░░░░░░ 8%
[orchestrator] Phase 1: ideation
...3 минуты тишины...
[progress] ideation completed in 182.8s
[budget] Phase cost: $0.5254, total: $0.5254
```

Нет:
- Возможности паузы без SIGINT (Ctrl+C = graceful shutdown, но возобновление требует перезапуска)
- Интерактивного изменения конфига в runtime
- Просмотра промежуточных результатов агентов
- Понимания, что агент делает прямо сейчас (event log пишется, но не в terminal)
- Web-интерфейса (`.autonomous-dev/dashboard.html` генерируется монитором, но это статический HTML)

### Что мешает нормальному DX

1. **`confirmSpec`** ждёт `process.stdin.once("data", ...)` — это работает только в интерактивном терминале. В CI, Docker, или web-запуске это зависает.

2. **Нет structured progress в stdout**. `progress.emit("phase:start", ...)` существует, но `src/utils/progress.ts` использует `EventEmitter` только для terminal rendering. Нет JSON-stream вывода, который мог бы читать frontend.

3. **Resume через флаг `--resume`** — пользователь должен знать session ID. Лучше: `--resume latest` или авто-resume при наличии `state.currentPhase !== "monitoring"`.

4. **Нет dry-run для отдельной фазы**. `--dry-run` симулирует весь pipeline, но нельзя dry-run только `architecture` чтобы увидеть план без трат.

---

## 8. Рекомендации для frontend dashboard (Variant B)

На основе анализа реального прогона, dashboard должен решать конкретные проблемы наблюдаемости и контроля.

### Обязательные панели

**1. Live Phase Progress**
- Текущая фаза с прогресс-баром и временем выполнения
- Затраты per-фаза и накопленный итог (с budget gauge)
- Список завершённых фаз с `costUsd`, `durationMs`, `verdict` рубрики
- Кнопки: Pause / Resume / Stop + Restart from phase X

**2. Agent Activity**
- Какой агент сейчас работает (из `agent.query.start` событий)
- Tool calls в реальном времени: `agent.tool.use` → показывать `Read("backend/app/routes.py")`
- Метрики агентов: сколько раз вызван, средняя стоимость, последний результат
- Для domain agents: кнопка «View Blueprint» → открывает `.v1.md` файл

**3. State Inspector**
- Текущий `state.json` в читаемом виде (не raw JSON)
- Tabs: Spec, Architecture, Tasks, Agents, Memory
- Tasks: прогресс батчей, статус каждой задачи (pending/in_progress/completed/failed)
- Кликабельный просмотр кода сгенерированного агентом

**4. Self-Improvement Controls**
- `evolution[]` история: какие мутации применены, как изменился score
- Кнопка «Run Optimizer» с выбором агента и maxIterations
- Benchmark results: визуализация scores по агентам
- Diff viewer для просмотра изменений промптов между версиями

**5. Rubric Evaluation**
- Per-phase rubric scores: спидометры 0.0–1.0 для каждого критерия
- Verdict badge: satisfied / needs_revision / failed
- История: как менялись scores по итерациям
- Кнопка «Re-evaluate» для ручного запуска grader

**6. Memory Store**
- Список сохранённых знаний (topic, tags, версии)
- Search по содержимому
- Просмотр и ручное редактирование документов
- История изменений per-документа

**7. Project Creation & Config**
- Форма с идеей, моделью, бюджетом, режимом (quick/full)
- Toggle: enable MemoryStore / Rubric evaluation / Self-improvement
- История прошлых прогонов (из event logs) с сравнением стоимостей

**8. Code Preview**
- File tree генерируемого проекта
- Diff view: что изменилось за последний батч
- Inline комментарии от reviewer агента

### Архитектурная заметка

Dashboard должен читать данные из двух источников:
- `state.json` — для персистентного состояния (spec, architecture, agents)
- `events/*.jsonl` — для real-time метрик и timeline

Оркестратор должен поддерживать **JSON stream mode**: при `--json-stream` писать события в stdout как JSONL. Frontend подключается через SSE или WebSocket к обёртке, которая читает этот стрим.

---

## 9. Приоритизированный план улучшений

### P0 — Критические баги состояния (Effort: S)

**1. Заполнять `completedPhases` и `phaseResults` в оркестраторе** _(S)_
- Что: добавить 5 строк в `runOrchestrator` после каждого успешного phase result
- Почему: dashboard и resume-логика слепы без этих данных; трекинг стоимостей требует этого

**2. Импортировать задачи из `architecture.taskDecomposition` в `state.tasks`** _(S)_
- Что: в начале `runDevelopment` — если `tasks[]` пуст, заполнить из `architecture.taskDecomposition.tasks`
- Почему: двойная декомпозиция тратит ~$0.1-0.3 и теряет качество acceptance criteria из архитектуры

**3. Строгая Zod-валидация `components` в architecture** _(S)_
- Что: изменить schema в `llm-schemas.ts` — `components` = `z.array(ComponentSchema)`, не `z.array(z.string())`
- Почему: сейчас LLM возвращает строки, система принимает без ошибки — тихий регресс

### P1 — Наблюдаемость (Effort: S-M)

**4. Включить rubric evaluation для `development` и `testing` по умолчанию** _(M)_
- Что: вызывать `gradePhaseOutput()` в оркестраторе после этих фаз; результат писать в `state.phaseResults`
- Почему: единственный механизм проверки `acceptance_criteria_met` — самое важное требование к качеству

**5. Persisting `totalCostUsd` в каждом `saveState()`** _(S)_
- Что: убедиться что `state.totalCostUsd = totalCostUsd` перед каждым `saveState()` в loop
- Почему: при crash данные о потраченном бюджете теряются

**6. `environment-setup` должна сохранять частичные результаты** _(S)_
- Что: писать в state после каждого обнаруженного MCP/LSP сервера, не только в конце
- Почему: сейчас `environment = null` — development не получает MCP серверы

### P2 — Качество промптов (Effort: M)

**7. Убрать `Output ONLY the JSON` из SPEC_PROMPT и ARCH_PROMPT** _(M)_
- Что: разрешить thinking перед JSON; использовать SDK-level `outputFormat` для принудительного парсинга
- Почему: запрет CoT снижает качество рассуждений при сложных решениях

**8. Добавить `keywords[]` в domain agents, починить matching** _(S)_
- Что: в `generateDomainAgents()` добавить поле `keywords`; в `buildBatchAgents()` матчить по ним
- Почему: текущий substring-матчинг пропускает специалиста для LLM-задач без слова "llm" в тайтле

**9. Cross-reference US→T в ARCH_PROMPT** _(S)_
- Что: добавить требование «каждая задача должна ссылаться на US-XXX»
- Почему: обеспечивает трассируемость и проверяемость покрытия user stories

### P3 — Self-improvement интеграция (Effort: M-L)

**10. Авто-запуск оптимизатора после `testing` при failures** _(M)_
- Что: в оркестраторе — если `testing` вернул `rubricResult.verdict !== "satisfied"`, запустить `runOptimizer` с `maxIterations: 3`
- Почему: сейчас self-improvement — dead code в normal operation; без данных о качестве он слеп

**11. Deterministic benchmarks вместо LLM-judge для базовых проверок** _(M)_
- Что: в `benchmark-defaults.ts` заменить LLM-judge на `typecheck`, `test run`, `lint` где возможно
- Почему: LLM-judge нестабилен для малых дельт — hill-climbing принимает шум за прогресс

**12. `MemoryStore` включить по умолчанию** _(S)_
- Что: `config.memory.enabled = true` с лимитами (100 docs, 50KB each) в default config
- Почему: rubric feedback накапливается только через MemoryStore; без него каждый прогон начинает с нуля

### P4 — DX и frontend (Effort: L)

**13. JSON stream mode для оркестратора** _(M)_
- Что: при `--json-stream` писать события из EventBus в stdout как JSONL
- Почему: позволяет frontend/CLI-wrapper подключиться к live progress без парсинга консоли

**14. `confirmSpec` через API, не stdin** _(S)_
- Что: заменить `process.stdin.once()` на event-based pause — оркестратор эмитит `session.state: {status: "waiting_for_confirmation"}` и ждёт сигнала через файл или IPC
- Почему: stdin блокирует headless режимы (CI, Docker, web)

**15. Frontend dashboard — Phase Progress + State Inspector** _(L)_
- Что: React/SvelteKit SPA читающий `state.json` + SSE из json-stream mode
- Почему: главный UX-пробел — нет обратной связи о том, что происходит

---

*Документ составлен: 2026-04-09 | Источники: product-execution-flow.md, state.json, src/orchestrator.ts, src/phases/*, src/self-improve/optimizer.ts, src/evaluation/grader.ts, src/state/memory-store.ts*
