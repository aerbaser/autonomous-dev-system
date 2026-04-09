# Анализ тестового запуска autonomous-dev-system
**Проект:** Local Email Chatbot (Gemma 4 / Ollama)  
**Run ID:** `e261a33b-f731-49cc-803b-c525c13bf03e`  
**Events log:** `6674c09a-300c-4166-a50e-76722c51d5c7.jsonl`  
**Дата запуска:** 2026-04-09, 11:45–12:35 UTC  
**Итог:** система остановилась на середине фазы development (без ошибки, без `phase.end` события)

---

## 1. Executive Summary

### Что сработало
- **Ideation** успешно сгенерировал полноценный product spec с 13 user stories, competitive analysis (Superhuman, Thunderbird, ProtonMail), MVP scope и tech stack recommendation (FastAPI + SvelteKit). Качество выше среднего.
- **Specification** pass-through корректно пропущен (1ms), переход на architecture сработал.
- **Architecture** сгенерировал детальную архитектуру: полный OpenAPI 3.1 YAML, SQL DDL с FTS5 и 5 индексами, дерево файлов, 43 задачи с acceptance criteria. Качество артефакта отличное.
- **Фазовые переходы** ideation → specification → architecture → environment-setup → development прошли без ошибок.
- **Генерация кода** в development написала 64 файла (57 Write + 7 Edit) — качество сгенерированного кода высокое (production-ready encryption service, типизированный IMAP клиент, 15+ тест-кейсов для encryption).

### Что не сработало
- Development **прервался** после ~37 минут работы без сохранения результатов последних батчей — 41/43 задачи в состоянии `pending`, хотя файлы записаны.
- **Cost lost**: стоимость development не учтена в `totalCostUsd` (batch 0 стоил $1.82, в state только $1.88 = ideation + architecture).
- **environment = null** — environment-setup скиппнут в quick mode, development работал без MCP-конфигурации.
- **Нет полей completedPhases / phaseResults** в state — невозможно запросить историю фаз.
- Batch 0 стоил $1.82 при всего 2 completed задачах — неприемлемая стоимость.

---

## 2. Баги

### BUG-01 — Стоимость development не сохраняется при прерывании
**Severity:** CRITICAL  
**Файл:** `src/orchestrator.ts:246-250`

```typescript
// Accumulate cost ONLY after phase completes
if (result.costUsd) {
  totalCostUsd += result.costUsd;
}
state = { ...result.state, totalCostUsd };
```

`totalCostUsd` обновляется только когда фаза вернула `result`. Если development прерван (SIGINT / crash) — весь потраченный бюджет теряется. В state.json `totalCostUsd = 1.8796` ($0.53 + $1.35), но реальный итог ~$3.70+.

**Данные:** events log — нет `orchestrator.phase.end` для development. Checkpoint metadata: `totalCost: 1.8226` (только batch 0 внутри development phase).

**Fix:** В `development-runner.ts` после каждого батча писать промежуточную стоимость в state:
```typescript
updatedState = { ...updatedState, totalCostUsd: (state.totalCostUsd ?? 0) + totalCost };
saveState(config.stateDir, updatedState);
```

---

### BUG-02 — 41/43 задач застряли в pending несмотря на записанные файлы
**Severity:** MAJOR  
**Файлы:** `src/phases/development-runner.ts:146-165`

**Хронология:**
- Batch 0 завершился в 12:29:28 → state сохранён → 2 completed (scaffolding)
- Audit log: файлы пишутся **после** 12:29:28 (database.py в 12:33:12, smtp_service.py в 12:35:41)
- state.json `updatedAt: 2026-04-09T12:29:28.921Z` — больше не обновлялся
- Итог: 64 файла на диске, в state только 2 completed задачи

**Root cause:** Batch 1+ записали файлы, но система прервалась до того как `executeBatch()` вернул результат → `updateTask()` и `saveState()` не вызваны. Файлы есть, state — нет.

**Усугубляющий фактор:** Все независимые задачи попадают в один батч (`groupIntoBatches` группирует все задачи без зависимостей вместе). Для 43 задач это может дать батч из 30+ задач с single `query()` call → если он прерван на середине, весь прогресс теряется.

**Fix A (тактический):** Ограничить размер батча (max 5-8 задач), чтобы потери при прерывании были минимальными.  
**Fix B (стратегический):** Сохранять state после каждой завершённой задачи (task-level checkpointing), не только после батча.

---

### BUG-03 — environment-setup не эмитит `phase.end` при быстром пропуске
**Severity:** MINOR  
**Файл:** `src/orchestrator.ts:191-201`

```typescript
eventBus.emit("orchestrator.phase.start", { phase }); // ← эмитируется
// Quick mode: skip optional phases
if (quickMode && OPTIONAL_PHASES.includes(phase)) {
  // ... transition and continue
  // orchestrator.phase.end НЕ эмитируется ←
}
```

Events log: seq 6 = environment-setup **start** (11:58:25.317Z), seq 7 = development **start** (11:58:25.318Z). Нет события environment-setup.end.

**Fix:**
```typescript
if (quickMode && OPTIONAL_PHASES.includes(phase)) {
  eventBus.emit("orchestrator.phase.end", { phase, success: true, skipped: true, durationMs: 1 });
  // ...
}
```

---

### BUG-04 — `completedPhases` и `phaseResults` отсутствуют в state
**Severity:** MODERATE  
**Файлы:** `src/state/project-state.ts`, `src/types/llm-schemas.ts:341-357`

`ProjectState` и `ProjectStateSchema` не содержат полей для хранения истории фаз. Checkpoint'ы есть (`checkpoints: PhaseCheckpoint[]`), но они хранят только ID задач, а не результаты фаз (cost, duration, verdict, errors).

**Реальный эффект:** Нет возможности спросить "какие фазы завершились и сколько стоили". Dashboard показывает `phaseResults: {}`.

**Fix:** Добавить в `ProjectState`:
```typescript
phaseResults: Partial<Record<Phase, {
  success: boolean;
  costUsd: number;
  durationMs: number;
  completedAt: string;
  error?: string;
}>>
```

---

### BUG-05 — `environment = null` при пропуске environment-setup
**Severity:** MODERATE  
**Файл:** `src/phases/development-runner.ts:100`

```typescript
const mcpServers = state.environment
  ? getMcpServerConfigs(state.environment.mcpServers)
  : {}; // ← пустой объект без MCP-серверов
```

Architecture выбрала FastAPI + SvelteKit, но development-агенты запускались без MCP-серверов (нет python-lsp, нет специфичных инструментов). В quick mode это ухудшает качество генерации.

**Fix:** Либо не включать environment-setup в `OPTIONAL_PHASES`, либо в development fallback-ом строить минимальный mcpServers на основе `state.architecture.techStack`.

---

### BUG-06 — `parseTaskResults` слишком агрессивно помечает задачи как неуспешные
**Severity:** MODERATE  
**Файл:** `src/phases/development-runner.ts:354-397`

Heuristic fallback:
```typescript
const hasFail =
  outputLower.includes(titleLower) &&
  (outputLower.includes("failure") || outputLower.includes("failed"));
return { taskId: task.id, success: !hasFail && output.length > 0 };
```

Если orchestrator-агент написал "type-check failed, fixing..." и потом всё исправил, итоговый output содержит "failed" — задача помечается как failed. Это гарантирует занижение `success` rate.

**Fix:** Использовать только structured JSON output (убрать text heuristic), либо анализировать только последний раздел output.

---

## 3. Анализ производительности

### Ideation: 183 секунды / $0.525
**Оценка:** Приемлемо с оговорками.

- 3× WebSearch для анализа конкурентов + генерация spec → 10 turns, много tool calls
- Выход: 13 user stories, competitive analysis, NFRs, MVP scope — хороший результат
- **Потенциальная оптимизация:** Запускать domain analysis параллельно с WebSearch (уже так), но можно сократить количество iterations в competitor research

### Architecture: 611 секунд / $1.354
**Оценка:** Слишком долго и дорого.

Детали из state.json: сгенерировал OpenAPI YAML (~300 строк), полный SQL DDL с 5 таблицами + FTS5, дерево файлов, **43 задачи** с acceptance criteria. Архитектурный агент явно прошёл много итераций с WebSearch для проверки версий библиотек.

`maxTurns: 10` для architecture, но итог = 611s — возможно, каждый turn был очень длинным (большой structured output).

**Рекомендации:**
1. Разделить на два отдельных агента: `system-architect` (tech stack + components + schema) и `task-planner` (task decomposition). Запускать параллельно.
2. Добавить кэширование architecture между runs с одинаковым spec.
3. Ограничить `taskDecomposition` до 20 задач — агент сам разбил на 43 слишком детальных.

### Development: 37+ минут / $1.82+ (только batch 0)
**Оценка:** Критически плохо.

- `maxTurns: 200` для development — непомерно много
- `default: 50` turns для sub-агентов тоже высоко
- Batch 0 с 2 задачами (scaffolding) стоил $1.82: orchestrator-агент с maxTurns=200 потратил много ресурсов на организацию работы суб-агентов
- После batch 0 запустились новые батчи (файлы 12:33-12:35), но стоимость неизвестна

**Рекомендации:**
1. `development: 200` → `60-80` (достаточно для 5-8 задач на батч)
2. `default: 50` → `30` для task-агентов (scaffolding не требует 50 turns)
3. Ограничить размер батча до 5 задач
4. Добавить per-phase budget: `maxPhaseUsd: { development: 5.0 }`

---

## 4. Проблемы product logic

### 4.1 Specification — бессмысленный pass-through
```typescript
specification: async (state, _config) => ({
  success: true,
  nextPhase: "architecture",
  state
}),
```
1ms, $0. Фаза существует в жизненном цикле но ничего не делает. Либо:
- **Вариант A:** Удалить фазу из `ALL_PHASES`, сразу ideation → architecture
- **Вариант B:** Наполнить фазу: `--confirm-spec` пауза + краткий review агентом, детальная проверка user stories на completeness

**Рекомендация:** Вариант B — specification должна запускать QA-агента, который проверяет spec на полноту и противоречия перед architecture.

---

### 4.2 environment-setup скиппается в quick mode — некорректно
`OPTIONAL_PHASES` включает environment-setup, но без него:
- Нет CLAUDE.md с project conventions
- MCP-серверы для Python (python-lsp, pytest-runner) не настроены
- Генерация кода хуже (агент не знает о project-specific паттернах)

**Рекомендация:** Убрать environment-setup из `OPTIONAL_PHASES`. Создать новую категорию `SKIPPABLE_PHASES` для review, ab-testing, monitoring. Или хотя бы запускать в quick mode только "minimal env setup" (без LSP install, только CLAUDE.md).

---

### 4.3 Self-improvement выключен по умолчанию
`evolution: []` в state.json. Ни одного improvement entry. Система не учится между запусками. Для системы с названием "self-improving" это проблема позиционирования.

**Рекомендация:** Включить базовый режим по умолчанию — после каждого успешного run записывать в memory store:
- Что сработало в spec/architecture
- Какие задачи провалились и почему
- Эффективные паттерны агентов

---

### 4.4 Rubric evaluation выключена по умолчанию
Без rubric evaluation нет автоматической quality gate на каждой фазе. Агент может вернуть некачественный результат, и система примет его.

**Рекомендация:** Включить rubric evaluation для ideation и architecture по умолчанию (самые важные фазы, дешёвые для повторной оценки). Development rubric оставить опциональной.

---

### 4.5 Нет visibility в ход выполнения задач
`dashboard.html` существует, но нет real-time обновлений статуса задач. Пользователь не знает что происходит внутри 37-минутного development.

---

## 5. Качество сгенерированного кода

### Общая оценка: Высокое для написанных файлов, но Coverage неполная

**Написанные файлы (64 штуки):**

| Файл | Качество | Замечания |
|------|----------|-----------|
| `backend/app/services/encryption_service.py` | ★★★★★ | Lazy init, правильная key validation, custom exceptions, warning on missing key |
| `backend/app/services/ollama_service.py` | ★★★★★ | Dataclasses, типизированные ответы, never-raises health_check |
| `backend/app/services/imap_service.py` | ★★★★☆ | Typed exceptions, regex STATUS parsing, timeout handling |
| `backend/app/services/mime_parser.py` | ★★★★☆ | email.policy.default, хороший dataclass |
| `backend/app/services/smtp_service.py` | ★★★★☆ | TLS enforcement (не проверен) |
| `backend/app/models/schemas.py` | ★★★★☆ | `SecretStr` для пароля, правильный AccountResponse |
| `backend/app/main.py` | ★★★☆☆ | Только `/api/ping`, нет роутеров |
| `backend/app/database.py` | ★★★★☆ | asynccontextmanager, WAL mode (не проверен) |
| `backend/Dockerfile` | ★★★★★ | Multi-stage, non-root user, healthcheck без curl |
| `backend/tests/test_encryption.py` | ★★★★★ | 15+ test cases, unicode, wrong key, tampered token |
| `backend/tests/test_mime_parser.py` | ★★★★☆ | Edge cases: RFC2047, charsets, multipart |
| `frontend/src/lib/components/ConnectionForm.svelte` | ★★★★☆ | Svelte 5 runes (`$state`, `$props`), provider presets |

### Проблемы:

**1. main.py почти пустой** — только `/api/ping`. Нет роутеров для accounts, emails, chat. Backbone приложения не реализован несмотря на 37+ минут работы.

**2. database.py написан, migration runner НЕТ** — задача #3 "Migration runner and initial database schema" в `pending`. `init_db()` — заглушка.

**3. Сервисы не скоординированы** — encryption_service, imap_service, smtp_service написаны, но `AccountCRUD` (задача #6) не реализован, поэтому никакой связи между компонентами нет.

**4. Несоответствие архитектуре** — architecture специфицировал `aiosqlite` connection pool с Semaphore, но `database.py` может быть написан без этого (не проверено из-за отсутствия файла в чтении).

**5. frontend/src/routes/+layout.svelte** переписан дважды (audit показывает два Write в 12:25:50 и 12:35:27) — агент перегенерировал файл, возможно, потеряв промежуточные изменения.

**6. Нет docker-compose.yml** — задача #43 в pending. Проект нельзя запустить без него.

**7. ConnectionForm.svelte** — грамотно написан с Svelte 5 runes, provider presets, loading state, error handling. Но API endpoint не существует (main.py пуст).

---

## 6. Отсутствующие фичи / улучшения

### Критические для usability:
1. **Task-level state saving** — сохранять status задачи сразу после её завершения, не ждать конца батча
2. **Phase cost tracking** — `phaseResults` в state с cost/duration для каждой фазы  
3. **Batch size limit** — `MAX_BATCH_SIZE = 5` предотвращает потерю 30+ задач при прерывании
4. **Resume from task** — возможность продолжить development с конкретной задачи по её ID, игнорируя "стёртую" history
5. **Interrupt → save mid-batch** — SIGINT должен дожидаться конца текущего батча или хотя бы помечать начатые задачи как `in_progress`, а не `pending`

### Важные для production:
6. **Per-phase budget cap** — `budgetUsd` только глобальный, нужен per-phase
7. **Progress dashboard** — `dashboard.html` существует, нужно real-time streaming через SSE
8. **Skip gracefully с fallback state** — при пропуске environment-setup хотя бы генерировать minimal `state.environment` на основе `state.architecture.techStack`
9. **Architecture cache** — при `--resume` не перегенерировать architecture если она уже в state
10. **Structured task result enforcement** — убрать text heuristic из `parseTaskResults`, требовать JSON

### Nice to have:
11. **`completedPhases` в state** — computed field или явное поле
12. **Rubric evaluation on by default** — для ideation и architecture
13. **Memory store по умолчанию** — хранить "что работало" между сессиями
14. **Cost estimate перед запуском** — `--dry-run` показывает estimated cost по аналогии с dry-run
15. **Webhook on completion** — notify пользователя когда long-running operation завершена

---

## 7. Приоритизированный план действий

### P0 — Критические баги (блокируют reliability):

1. **[BUG-02] Ограничить MAX_BATCH_SIZE до 5-8 задач**  
   `src/phases/development-runner.ts`, функция `groupIntoBatches()` — добавить параметр `batchSize` и разбивать независимые задачи на chunks.

2. **[BUG-01] Сохранять стоимость development после каждого батча в state.totalCostUsd**  
   `src/phases/development-runner.ts:165` — писать `updatedState.totalCostUsd` при каждом `saveState`.

3. **[BUG-02] Task-level checkpointing** — после завершения каждой задачи (не батча) вызывать `saveState`. Минимальная версия: проверять на старте development какие файлы уже существуют и помечать задачи как `completed` если их файлы есть.

4. **[BUG-06] Убрать text heuristic из `parseTaskResults`** — если structured JSON нет, помечать batch как "unknown" и логировать, но не угадывать по словам "failed".

### P1 — Важные улучшения (влияют на стоимость и качество):

5. **[PERF] Снизить `maxTurns.development` с 200 до 60**, `default` с 50 до 25  
   `src/utils/config.ts:29-44`

6. **[PERF] Разделить architecture на два параллельных агента** (system-design + task-planning)  
   `src/phases/architecture.ts`

7. **[LOGIC-4.2] Убрать environment-setup из OPTIONAL_PHASES**  
   `src/orchestrator.ts:50`

8. **[BUG-04] Добавить `phaseResults` в ProjectState** для tracking стоимости и результатов по фазам  
   `src/state/project-state.ts`, `src/types/llm-schemas.ts`

### P2 — Product improvements:

9. **[LOGIC-4.1] Наполнить specification фазу** — QA-агент проверяет spec на completeness перед architecture

10. **[BUG-03] Эмитить `phase.end` при пропуске в quick mode**  
    `src/orchestrator.ts:195`

11. **[BUG-05] Fallback minimal environment** при пропуске environment-setup  
    `src/phases/development-runner.ts:100`

12. **[LOGIC-4.4] Включить rubric evaluation для ideation/architecture по умолчанию**  
    `src/utils/config.ts` — `rubrics.enabled: true` только для первых двух фаз

### P3 — Инфраструктура и UX:

13. **Добавить per-phase cost tracking в `executePhaseSafe`** — аккумулировать стоимость в `PhaseResult` и обновлять state сразу

14. **Real-time dashboard** через SSE endpoint с progress events

15. **`--resume-from-task <taskId>` флаг** для ручного возобновления development с конкретной точки

---

## Приложение: Ключевые числа из state.json

```
Run duration:       ideation 183s + architecture 611s + development 37min+
Total phases:       5/12 пройдено (ideation, specification, architecture, env-setup skipped, development running)
Tasks:              43 total, 2 completed, 41 pending
Files written:      64 (57 Write + 7 Edit)
Cost tracked:       $1.88 (ideation $0.53 + architecture $1.35)
Cost untracked:     $1.82+ (development batch 0) + unknown (batch 1+)
Estimated total:    $3.70+
environment:        null (quick mode skip)
phaseResults:       {} (field не существует в state)
completedPhases:    не существует в state
```
