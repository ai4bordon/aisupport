# Веб-чат → ответ из БЗ → эскалация: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до Г3a и отдельного «поехали» владельца.**

**Цель:** Вертикальный срез веб-чата: вопрос клиента → поиск по одобренной БЗ → подтверждённый ответ со ссылкой либо эскалация менеджеру.

**Границы среза:** только ядро и веб-канал. Импорт фида, импорт базы знаний с сайта, документы, барьер доступа и MAX-адаптер — отдельные срезы волны 1 со своими планами: `docs/plans/08-import-catalog-feed.md`, `docs/plans/09-import-knowledge-site.md`, `docs/plans/07-access-stand-guard.md`. Их таблицы и миграции этот срез не создаёт.

**Архитектура:** Один процесс Next.js/TypeScript. Route Handler `POST /v1/chat` нормализует сообщение и вызывает ядро. Ядро использует модули `knowledge`, `policy` и `telemetry` через их публичные `index.ts`; внутренние модули не знают HTTP. MAX и админка в этом срезе отсутствуют.

**Владение файлами:** срез владеет `src/core/**`, `src/db/**`, `src/contracts/**`, `src/app/api/chat/**`, `src/app/api/agent/**`, `src/app/api/health/**`, `src/app/api/kb/**`, `src/app/widget/**`, `src/modules/knowledge/index.ts`, `src/modules/knowledge/search.ts`, `src/modules/policy/**`, `src/modules/telemetry/**`. Общие поверхности — контракт, модель данных, роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts` — не меняются.

**Технологии:** Node.js 22 LTS, Next.js 16 App Router, TypeScript, PostgreSQL 16 + pgvector, `pg`, `pgvector`, `node-pg-migrate`, Vitest, React Testing Library.

**Тикет:** `.scratch/support-agent/issues/01-web-chat-kb-escalation.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`); контракт: `docs/api-contract.md`; данные: `docs/data-model.md`; решения: `adr/0001-modular-monolith.md` … `adr/0008-shadow-mode.md`; глоссарий: `GLOSSARY.md`; правила волны: `docs/plans/wave-1.md`.

## Команда проверки

`npm run test -- tests/integration/01-web-chat-kb-escalation.test.ts`

Команда обязательна к приёмке среза. Юнит-тесты среза — обязательные шаги плана; интеграционный тест собирает их вместе и проверяет срез целиком.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Один процесс Node.js/TypeScript; один внешний HTTP API; внутренние модули вызываются через `index.ts`.
- Суммы считает только код. В этом срезе расчёта сумм нет: модули `catalog`, `calc` и `documents` запрещено добавлять — они в других срезах волны.
- Валидатор цифр обязателен; без источника — эскалация, не выдуманный ответ.
- В модель передаются только метки ПД. Имя, ФИО, организация, адрес, телефон, email, ИНН, банковские и паспортные данные маскируются; таблица соответствий не покидает серверную часть.
- В БЗ попадают только одобренные документы и опубликованные статьи. `pending`, `draft`, `rejected` не возвращаются поиском.
- LLM до первого токена — 120 с; внутренний шаг — 5 с; весь диалог — 300 с; один повтор после 429 через 30 с; повторная ошибка — эскалация.
- Режим тени: ответ клиенту не отправляется, создаётся черновик/эскалация.
- Токены, ключи и секреты — только переменные окружения/секретница; не в репозитории, трассе, доказательствах и описании.
- MAX-канал обязателен в общем объёме, но выполняется отдельным тикетом после этого среза.
- Защита публичного стенда (код доступа → cookie, лимиты, потолок бюджета) — отдельный тикет после этого среза; контракт `/v1/chat` должен допускать её добавление без изменения формы запроса и ответа.
- Каталог заказчика — 136 040 позиций в фиде; векторный индекс к каталогу не применяется, поиск структурный. Вектор — только к базе знаний и статьям.
- Обход сайта базы знаний: один запрос в секунду, глубина до трёх, при `429` или `5xx` обход останавливается, работа продолжается на закэшированном материале.
- Данные демо синтетические и помечены как допущение; материалы заказчика для каталога, базы знаний и переписок подключаются отдельными срезами.
- Миграции этого среза — диапазон 100–999: 100, 110, 120, 130, 140, 150, 160, 170. Номер выбирает exec, агент числа не назначает.

## На что обратить внимание при проверке

- Вопрос без одобренного источника → `escalate` с `reason=no_confirmed_source`, а не ответ по памяти модели.
- Неодобренная статья или документ с `pending`/`draft`/`rejected` не попадают в выдачу поиска.
- Повтор одного `client_message_id` не создаёт второе обращение и второй ответ.
- Два одновременных хода в одном диалоге не пересекаются: второй ждёт первый.
- ПД в исходном сообщении не попадают в запрос к модели и в текст ответа.
- Ошибка или таймаут модели дают эскалацию с `upstream_error`/`upstream_timeout`, не «извините, попробуйте позже» без записи в очереди менеджера.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `package.json` | Зависимости и команды `dev`, `test`, `db:migrate:*`, `lint`, `typecheck` |
| `tsconfig.json` | Строгий TypeScript, path alias `@/*` |
| `next.config.ts` | Конфигурация Next.js 16 |
| `vitest.config.ts` | Vitest, jsdom для компонентов, node для модулей |
| `db/migrations/100_extensions.sql` | `pgcrypto`, `vector` |
| `db/migrations/110_tenants.sql` | `tenants` |
| `db/migrations/120_conversations.sql` | `conversations`, `messages` |
| `db/migrations/130_knowledge_core.sql` | `kb_documents`, `kb_articles`, `kb_chunks`, `agent_steps` |
| `db/migrations/140_escalations_promises.sql` | `escalations`, `promises` |
| `db/migrations/150_policy_rules.sql` | `policy_rules` |
| `db/migrations/160_audit.sql` | `audit_log` |
| `db/migrations/170_intent_taxonomy.sql` | `intent_taxonomy` + девять категорий |
| `db/migrations/170_intent_taxonomy.sql` | `intent_taxonomy` + девять категорий |
| `db/seed.ts` | Синтетический тенант, опубликованная статья, черновик статьи, документ `pending` |
| `src/db/pool.ts` | `pg.Pool`, регистрация типов pgvector, подключение по `DATABASE_URL` |
| `src/db/tenant.ts` | Единая точка получения `tenant_id` из сессии |
| `src/contracts/chat.ts` | Zod-схемы входа/выхода `/v1/chat` и `/agent/run` |
| `src/core/run.ts` | Оркестрация 7 узлов, выбор `respond`/`escalate` |
| `src/core/model.ts` | Интерфейс модели; DeepSeek через OpenCode Go, запасной адрес, один повтор |
| `src/core/mask.ts` | Маскирование ПД и восстановление меток |
| `src/core/validate.ts` | Валидатор цифр, цитат и исходящего текста на сырые ПД |
| `src/core/session.ts` | Подпись и проверка cookie диалога, создание новой подписи |
| `src/modules/knowledge/index.ts` | Публичный read-API `search(query, tenantId)` |
| `src/modules/knowledge/search.ts` | Поиск по одобренной БЗ: вектор + текстовый запасной вариант |
| `src/modules/policy/index.ts` | Публичный API `check(request, tenantId)` |
| `src/modules/policy/rules.ts` | Правила полномочий, дефолт — эскалация |
| `src/modules/telemetry/index.ts` | Публичный API `recordStep(step)` |
| `src/modules/telemetry/steps.ts` | Запись трассы в `agent_steps` |
| `src/app/api/chat/route.ts` | `POST /v1/chat` |
| `src/app/api/health/route.ts` | `GET /health` |
| `src/app/widget/page.tsx` | Минимальный веб-виджет чата для ручной проверки |
| `src/app/widget/chat.tsx` | Клиентский компонент: отправка сообщения, показ ответа/эскалации |
| `tests/knowledge/search.test.ts` | Допуск к поиску только одобренного |
| `tests/core/run.test.ts` | Сценарии `respond`/`escalate` |
| `tests/core/mask.test.ts` | Маскирование и восстановление ПД |
| `tests/core/validate.test.ts` | Блокировка неподтверждённых сумм и цитат |
| `tests/api/chat.test.ts` | Контракт `/v1/chat` |
| `tests/api/health.test.ts` | Контракт `/health` |

---

### Задача 1: Каркас процесса, тесты и база

**Файлы:**
- Создать: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`
- Создать: `db/migrations/100_extensions.sql`, `db/migrations/110_tenants.sql`, `db/migrations/120_conversations.sql`, `db/migrations/130_knowledge_core.sql`, `db/migrations/140_escalations_promises.sql`, `db/migrations/150_policy_rules.sql`
- Создать: `src/db/pool.ts`, `db/seed.ts`
- Тест: `tests/db/migrations.test.ts`, `tests/api/health.test.ts`

**Интерфейсы:**
- Использует: `DATABASE_URL` из env.
- Даёт: `getPool(): Pool`, `closePool(): Promise<void>`, `GET /health` → `{ status: "ok", database: "ok" }`.

- [ ] **Шаг 1: Зафиксировать зависимости и команды в `package.json`**

  Версии, проверенные в npm на 26.11: `next@16.4.6`, `react@19.3.1`, `react-dom@19.3.1`, `pg@8.23.1`, `pgvector@0.3.1`, `zod@4.6.7`, `node-pg-migrate@9.0.0`, `vitest@5.1.2`, `@vitejs/plugin-react@6.3.0`, `jsdom@31.0.1`, `@testing-library/react@16.3.3`, `@testing-library/jest-dom@8.0.0`, `tsx@4.23.15`, `typescript@7.0.2`, `@types/node@26.6.11`, `@types/react@19.3.3`, `@types/react-dom@19.3.0`.

  Команды npm: `dev`, `build`, `test`, `test:watch`, `typecheck`, `db:migrate:up`, `db:migrate:down`, `db:migrate:status`, `db:seed`.

- [ ] **Шаг 2: Написать падающий тест миграций `tests/db/migrations.test.ts`**

  Проверки: расширение `vector` доступно; таблицы `tenants`, `conversations`, `messages`, `kb_documents`, `kb_articles`, `kb_chunks`, `agent_steps`, `escalations`, `promises`, `policy_rules` существуют; уникальный индекс `(tenant_id, client_message_id)` существует; HNSW-индекс `kb_chunks_embedding_idx` существует; ограничение `num_nonnulls(document_id, article_id) = 1` действует.

- [ ] **Шаг 3: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/db/migrations.test.ts`
  Ожидание: ПРОВАЛ — тестовая база или миграции отсутствуют.

- [ ] **Шаг 4: Поднять Docker Desktop и проверить образ `pgvector/pgvector:pg16`**

  Команда: `docker run --rm -d --name support-agent-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=support_agent_test -p 5433:5432 pgvector/pgvector:pg16`
  Ожидание: контейнер переходит в состояние `healthy`/готов принимать соединения.

  Если Docker Desktop недоступен — остановиться и отправить `BLOCKED` владельцу. In-memory замена БД не допускается.

- [ ] **Шаг 5: Создать миграции**

  `100_extensions.sql`: `CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector;`
  `110_tenants.sql`: таблица `tenants` из `docs/data-model.md`.
  `120_conversations.sql`: таблицы `conversations`, `messages` из `docs/data-model.md`.
  `130_knowledge_core.sql`: таблицы `kb_documents`, затем `kb_articles`, затем `kb_chunks` (FK на `kb_articles`), затем `kb_sources`, затем `agent_steps` — из `docs/data-model.md`.
  `140_escalations_promises.sql`: таблицы `escalations`, `promises` из `docs/data-model.md`.
  `150_policy_rules.sql`: таблица `policy_rules` из `docs/data-model.md`.

  Начальные данные: тенант `demo-tenant` (`shadow_mode=false`), опубликованная статья `Лицензирование`, черновик статьи `Постоплата`, документ `pending`. Векторы в тестовых данных детерминированные.

- [ ] **Шаг 6: Создать `src/db/pool.ts` и подключить pgvector**

  Экспортировать `getPool()` и `closePool()`. В `onConnect` вызвать `pgvector.registerTypes(client)`. Значение `DATABASE_URL` читать из `process.env`; ошибка подключения возвращать наружу как `503 upstream_unavailable`.

- [ ] **Шаг 7: Написать падающий тест `GET /health` `tests/api/health.test.ts`**

  Проверки: `200`, `status=ok`, `database=ok`; при недоступной БД — `503`, `error.code=upstream_unavailable`.

- [ ] **Шаг 8: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/api/health.test.ts`
  Ожидание: ПРОВАЛ — маршрут не найден.

- [ ] **Шаг 9: Реализовать `src/app/api/health/route.ts`**

  Сигнатура: `export async function GET(): Promise<Response>`. Проверка `SELECT 1` через `getPool()`.

- [ ] **Шаг 10: Применить миграции и заполнить тестовую базу**

  Команда: `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/support_agent_test npm run db:migrate:up && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/support_agent_test npm run db:seed`
  Ожидание: шесть миграций применены; начальные данные созданы без ошибок.

- [ ] **Шаг 11: Запустить тесты и убедиться в прохождении**

  Команда: `npm test -- tests/db/migrations.test.ts tests/api/health.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 12: Зафиксировать изменения**

```bash
git add package.json tsconfig.json next.config.ts vitest.config.ts .env.example db src/db src/app/api/health tests/db tests/api/health.test.ts
git commit -m "chore: scaffold support agent runtime and database"
```

---

### Задача 2: Маскирование ПД и валидатор ответов

**Файлы:**
- Создать: `src/core/mask.ts`, `src/core/validate.ts`
- Тест: `tests/core/mask.test.ts`, `tests/core/validate.test.ts`

**Интерфейсы:**
- Использует: нет.
- Даёт: `maskPersonalData(text: string, scope: MaskScope): MaskResult`, `restoreMaskedData(text: string, mapping: MaskMapping): string`, `validateAnswer(answer: CandidateAnswer, sources: Source[]): ValidationResult`.

```ts
type MaskResult = {
  maskedText: string;
  mapping: MaskMapping;
  maskedFieldsCount: number;
};

type MaskMapping = Record<string, string>; // метка → исходное значение

type CandidateAnswer = {
  text: string;
  amounts: number[];
  citations: string[];
};

type ValidationResult = {
  valid: boolean;
  violations: Array<{ code: string; detail: string }>;
};
```

- [ ] **Шаг 1: Написать падающие тесты маскирования `tests/core/mask.test.ts`**

  Проверки: ФИО, организация, адрес, телефон, email, ИНН, банковский счёт и паспорт заменяются метками; одно и то же значение получает одну метку в рамках диалога; `maskedText` не содержит исходных значений; `restoreMaskedData` возвращает исходный текст.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/core/mask.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/core/mask.ts`**

  Сигнатуры из блока «Интерфейсы». Маскировать до вызова модели; маска имеет вид `⟦PERSON_1⟧`, `⟦ORG_1⟧`, `⟦PHONE_1⟧`, `⟦EMAIL_1⟧`, `⟦INN_1⟧`, `⟦BANK_1⟧`, `⟦PASSPORT_1⟧`, `⟦ADDRESS_1⟧`. Дедупликация — по нормализованному значению.

- [ ] **Шаг 4: Написать падающие тесты валидатора `tests/core/validate.test.ts`**

  Проверки: сумма, отсутствующая среди источников, даёт violation `amount_not_in_source`; цитата, отсутствующая в источнике, даёт `citation_not_in_source`; точное совпадение суммы и цитаты даёт `valid=true`; пустой список источников даёт `valid=false`; исходящий текст с сырым ФИО, телефоном, email, ИНН, банковским счётом или паспортом даёт violation `raw_pii_in_outgoing` и `valid=false`; текст только с метками проходит проверку.

- [ ] **Шаг 5: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/core/validate.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 6: Реализовать `src/core/validate.ts`**

  Сигнатуры из блока «Интерфейсы». Сравнение цитат — точное совпадение с текстом источника после нормализации пробелов и регистра. Сравнение сумм — целочисленное, допускается только совпадение с числом источника. Проверка исходящего текста ищет сырые ПД по тем же шаблонам, что и маскировщик: ФИО, организация, адрес, телефон, email, ИНН, банковский счёт, паспорт; при совпадении ответ не отправляется.

- [ ] **Шаг 7: Запустить тесты и убедиться в прохождении**

  Команда: `npm test -- tests/core/mask.test.ts tests/core/validate.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 8: Зафиксировать изменения**

```bash
git add src/core/mask.ts src/core/validate.ts tests/core/mask.test.ts tests/core/validate.test.ts
git commit -m "feat: mask personal data and validate sourced answers"
```

---

### Задача 3: Чтение одобренной БЗ

**Файлы:**
- Создать: `src/modules/knowledge/index.ts`, `src/modules/knowledge/search.ts`, `src/modules/telemetry/index.ts`, `src/modules/telemetry/steps.ts`
- Тест: `tests/knowledge/search.test.ts`

**Интерфейсы:**
- Использует: `getPool()`, `MaskResult` из задачи 2.
- Даёт: `knowledge.search(query: string, tenantId: string, limit?: number): Promise<SearchResult[]>`, `telemetry.recordStep(step: AgentStep): Promise<void>`.

```ts
type SearchResult = {
  articleId: string;
  chunkId: string;
  title: string;
  text: string;
  location: string | null;
  score: number;
};

type AgentStep = {
  conversationId: string;
  node: string;
  endpoint: string | null;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  latencyMs: number;
  metadata: Record<string, unknown>;
  sourceIds: string[];
  outcome: "respond" | "escalate" | null;
  model: string | null;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/knowledge/search.test.ts`**

  Фикстура: опубликованная статья `published`, черновик статьи `draft`, документ `pending`. Проверки: поиск возвращает только `published`; в тексте выдачи нет содержимого `draft`/`pending`; пустой результат возвращает `[]`, а не выдуманный ответ; `limit` ограничивает число результатов.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/knowledge/search.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/modules/knowledge/search.ts`**

  Векторный поиск: `embedding <=> $queryEmbedding` с `ORDER BY` и `LIMIT`; текстовый запасной вариант: `search_vector @@ plainto_tsquery('russian', $query)`. В выдачу включать только `kb_articles.status='published'` и `kb_documents.status='published'`. Эмбеддинг запроса получать через инъецируемый `EmbeddingProvider`; тесты используют детерминированную фикстуру.

- [ ] **Шаг 4: Реализовать публичные `index.ts`**

  `src/modules/knowledge/index.ts` экспортирует только `search`. `src/modules/telemetry/index.ts` экспортирует только `recordStep`. Внутренние файлы не импортируются напрямую вне модуля.

- [ ] **Шаг 5: Запустить тест и убедиться в прохождении**

  Команда: `npm test -- tests/knowledge/search.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 6: Зафиксировать изменения**

```bash
git add src/modules/knowledge src/modules/telemetry tests/knowledge/search.test.ts
git commit -m "feat: search only approved knowledge sources"
```

---

### Задача 4: Ядро: ответ из БЗ или эскалация

**Файлы:**
- Создать: `src/core/run.ts`, `src/core/model.ts`, `src/modules/policy/index.ts`, `src/modules/policy/rules.ts`
- Тест: `tests/core/run.test.ts`

**Интерфейсы:**
- Использует: `maskPersonalData`, `restoreMaskedData`, `validateAnswer`, `knowledge.search`, `policy.check`, `telemetry.recordStep`.
- Даёт: `runAgent(input: NormalizedMessage): Promise<AgentOutcome>`.

```ts
type NormalizedMessage = {
  conversationId: string;
  messageId: string;
  channel: "web" | "max";
  externalChatId: string | null;
  text: string;
  maskedFieldsCount: number;
};

type AgentOutcome =
  | {
      outcome: "respond";
      answer: { text: string; sources: Source[] };
      escalation: null;
      steps: AgentStep[];
    }
  | {
      outcome: "escalate";
      answer: null;
      escalation: {
        id: string;
        reason: string;
        summary: string;
        draft: string | null;
      };
      steps: AgentStep[];
    };
```

- [ ] **Шаг 1: Написать падающие тесты `tests/core/run.test.ts`**

  Сценарии: (1) одобренный источник → `respond`, ответ содержит ссылку на источник, сумма отсутствует; (2) нет одобренного источника → `escalate`, `reason=no_confirmed_source`; (3) policy запрещает ответ → `escalate`, `reason=policy_denied`; (4) ошибка модели → `escalate`, `reason=upstream_error`; (5) таймаут → `escalate`, `reason=upstream_timeout`; (6) модель вернула сумму без источника → `escalate`, в трассе violation `amount_not_in_source`; (7) трасса содержит узлы `classify`, `retrieve`, `validate`, `respond|escalate`.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/core/run.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/modules/policy/rules.ts` и `index.ts`**

  API: `policy.check(request: PolicyRequest, tenantId: string): Promise<PolicyDecision>`. Дефолт: любое правило без подтверждённого значения → `escalate`. `PolicyDecision`: `{ allowed: boolean; reason: string | null }`.

- [ ] **Шаг 4: Реализовать `src/core/model.ts`**

  Интерфейс `ModelClient.complete(request: ModelRequest): Promise<ModelResult>`; DeepSeek через OpenCode Go — основной, запасной адрес — резервный вариант. Тайм-аут 120 с до первого токена; один повтор через 30 с после 429; повторная ошибка → `ModelUnavailableError`.

- [ ] **Шаг 5: Реализовать `src/core/run.ts`**

  Последовательность: классификация → поиск → policy → генерация ответа → валидация → ответ/эскалация. Модель получает только маскированный текст и подтверждённые источники. Каждый узел пишет шаг через `telemetry.recordStep`. Любой сбой превращается в эскалацию с соответствующим `reason`.

- [ ] **Шаг 6: Запустить тест и убедиться в прохождении**

  Команда: `npm test -- tests/core/run.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 7: Зафиксировать изменения**

```bash
git add src/core/run.ts src/core/model.ts src/modules/policy tests/core/run.test.ts
git commit -m "feat: answer from approved knowledge or escalate"
```

---

### Задача 5: HTTP API `/v1/chat` и веб-виджет

**Файлы:**
- Создать: `src/contracts/chat.ts`, `src/db/tenant.ts`, `src/core/session.ts`, `src/app/api/chat/route.ts`, `src/app/widget/page.tsx`, `src/app/widget/chat.tsx`
- Тест: `tests/api/chat.test.ts`, `tests/integration/01-web-chat-kb-escalation.test.ts`

**Интерфейсы:**
- Использует: `runAgent`, `maskPersonalData`, `restoreMaskedData`, `getPool`.
- Даёт: `POST /v1/chat` по контракту `docs/api-contract.md` §4.

- [ ] **Шаг 1: Написать падающий тест `tests/api/chat.test.ts`**

  Проверки: валидный вопрос → `200`, `outcome=respond`, есть `conversation_id`, `message_id`, `sources`; вопрос без источника → `200`, `outcome=escalate`, `answer=null`, `escalation.reason=no_confirmed_source`; неверное тело → `400`, `error.code=validation_error`; повтор `client_message_id` → тот же `conversation_id`, второй ответ не создаётся; ПД в ответе восстановлены, в `trace` нет исходных значений; запрос без cookie → новый диалог и `Set-Cookie`; запрос с cookie и совпадающим `conversation_id` → продолжение того же диалога; `conversation_id` в теле, не совпадающий с cookie → `403`; два клиента с одинаковым IP → разные `conversation_id`; подделанная подпись cookie → новый диалог; outgoing-текст с сырым ПД → `422`, ответ клиенту не отправлен.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/api/chat.test.ts`
  Ожидание: ПРОВАЛ — маршрут не найден.

- [ ] **Шаг 3: Реализовать `src/contracts/chat.ts`**

  Zod-схемы `ChatRequestSchema`, `ChatResponseSchema` по `docs/api-contract.md` §4. Ограничение текста: 1–4000 символов.

- [ ] **Шаг 4: Реализовать `src/core/session.ts` и cookie в `src/app/api/chat/route.ts`**

  `src/core/session.ts`: `signConversationId(id: string): string`, `readConversationId(cookieHeader: string | undefined): { id: string } | null`. Подпись — HMAC-SHA256 с секретом `SESSION_SECRET` из env; сравнение подписи — constant-time. В роуте: прочитать cookie → при отсутствии/невалидной подписи создать новый диалог и выдать `Set-Cookie: support_conversation=<id>.<sig>; HttpOnly; Secure; SameSite=Lax; Path=/`; при валидной cookie сверить `conversation_id` тела с cookie и вернуть `403` при расхождении. IP не читается и не сохраняется.

  Далее: определить `tenant_id` сервером → маскировать → вызвать `runAgent` → восстановить метки → записать `messages` и `agent_steps`; при `outcome=escalate` записать `escalations` → вернуть контракт. Идемпотентность — unique `(tenant_id, client_message_id)` и `ON CONFLICT DO NOTHING`.

- [ ] **Шаг 5: Реализовать минимальный веб-виджет `src/app/widget/page.tsx` и `chat.tsx`**

  Поля: текст сообщения, кнопка отправки, история сообщений, блок источников, состояние эскалации. Без токенов и реальных ПД; демо-текст синтетический.

  По R26 и ADR-0012: оформление через CSS custom properties из `src/app/styles/tokens.css` — свои hex в компонентах не заводятся; стек шрифтов `var(--sl-font-sans)`; в шапке официальный логотип «Софтлайн Решения + SOFL» из `docs/лого софтлайн/` (цветная версия на светлом фоне), без поворота, деформации, теней и обводок, с охранным полем не меньше высоты логотипа (`var(--sl-logo-guard)`).

- [ ] **Шаг 6: Написать интеграционный тест `tests/integration/01-web-chat-kb-escalation.test.ts`**

  Проверки по AC тикета: (1) новый веб-диалог с вопросом по опубликованной синтетической статье получает ответ со ссылкой на источник; (2) вопрос без опубликованного источника создаёт запись эскалации с причиной, `conversation_id`, summary и трассой, клиенту не уходит неподтверждённый факт; (3) подписанная cookie продолжает диалог, отсутствие cookie создаёт новый, два клиента с одинаковым IP не объединяются; (4) входные ПД доходят до границы модели только метками, таблица соответствий и секреты не логируются, outgoing-валидация отклоняет сырые ПД; (5) трасса содержит упорядоченные операции, `source_ids`, `outcome`, длительность и usage, без учётных данных; (6) в тесте нет кода MAX и полной админки.

- [ ] **Шаг 7: Запустить тесты и убедиться в прохождении**

  Команда: `npm test -- tests/api/chat.test.ts tests/integration/01-web-chat-kb-escalation.test.ts`
  Ожидание: ПРОВЕДЕНО.


- [ ] **Шаг 8: Зафиксировать изменения**

```bash
git add src/contracts/chat.ts src/app/api/chat src/app/widget tests/api/chat.test.ts
git commit -m "feat: expose web chat endpoint and widget"
```

---

### Задача 6: Проверка вертикального среза и доказательства

**Файлы:**
- Изменить: `docs/api-contract.md` — только если реализация выявила несовпадение контракта.
- Изменить: `docs/data-model.md` — только если миграции отклонились от зафиксированной модели.

**Интерфейсы:**
- Использует: все предыдущие задачи.
- Даёт: доказательства для Г3b по `.scratch/support-agent/issues/01-web-chat-kb-escalation.md`.

- [ ] **Шаг 1: Запустить полный набор тестов**

  Команда: `npm test`
  Ожидание: ПРОВЕДЕНО, код завершения 0.

- [ ] **Шаг 2: Запустить проверку типов и сборку**

  Команда: `npm run typecheck && npm run build`
  Ожидание: код завершения 0.

- [ ] **Шаг 3: Запустить приложение с тестовой БД**

  Команда: `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/support_agent_test npm run dev`
  Ожидание: сервер поднялся, `GET /health` → `200`.

- [ ] **Шаг 4: Проверить сценарий ответа вручную**

  Открыть `/widget`, отправить вопрос по опубликованной статье.
  Ожидание: ответ со ссылкой на источник; в трассе видны узлы агента.

- [ ] **Шаг 5: Проверить сценарий эскалации вручную**

  Отправить вопрос, для которого нет опубликованного источника.
  Ожидание: `escalate`, `reason=no_confirmed_source`, создан черновик/эскалация; ответа с неподтверждёнными фактами нет.

- [ ] **Шаг 6: Проверить режим тени**

  Включить режим тени для тенанта (`UPDATE tenants SET shadow_mode = true WHERE slug = 'demo-tenant'`) и повторить сценарий с ответом.
  Ожидание: наружу ответа клиенту нет; в очереди менеджера есть черновик/эскалация. После проверки вернуть `shadow_mode = false`.

- [ ] **Шаг 7: Проверить маскирование ПД**

  Отправить сообщение с ФИО, организацией, адресом, телефоном, email, ИНН и банковским счётом.
  Ожидание: в логе запроса к модели только метки; в ответе клиенту значения восстановлены; таблица соответствий не покидает серверную часть.

- [ ] **Шаг 8: Проверить фирменный стиль веб-чата**

  Проверить, что CSS виджета использует только переменные из `src/app/styles/tokens.css`, что своих hex в компонентах нет, что логотип в шапке — официальный вариант с охранным полем.
  Ожидание: вычисленные CSS custom properties дают web-палитру R26 и стек `Montserrat, "Segoe UI", system-ui, sans-serif`; ни одного брендового hex вне токенов; логотип не искажён, свободное поле не меньше его высоты.

- [ ] **Шаг 9: Зафиксировать доказательства**
  Сохранить в `.house/work/<task-id>/` команды и их коды завершения: `npm test`, `npm run typecheck`, `npm run build`, ручные проверки `/widget` и `/health`. Секреты в доказательствах не записывать.

- [ ] **Шаг 9: Зафиксировать изменения**

```bash
git add docs/api-contract.md docs/data-model.md
git commit -m "docs: align contract and data model with verified slice"
```

## Самопроверка плана

- **Покрытие:** срез покрыт задачами 1–6 и только ими: веб-чат, поиск по одобренной БЗ, ответ со ссылкой либо эскалация, маскирование ПД, проверка исходящего текста, трасса. Импорт фида, импорт базы знаний, документы, доступ к стенду, MAX, админка и аналитика — отдельные срезы волны 1 и волны 2 со своими планами.
- **Шаги:** каждый шаг даёт один проверяемый артефакт; команды указаны с ожидаемым результатом.
- **Типы:** `runAgent`, `knowledge.search`, `policy.check`, `telemetry.recordStep`, `maskPersonalData`, `validateAnswer` согласованы между задачами.
- На что обратить внимание при проверке: каждому пункту соответствует тест — маскирование в задаче 2, неодобренная БЗ в задаче 3, эскалация и ошибки в задаче 4, идемпотентность и ПД в задаче 5, режим тени в задаче 6.
- **Пропорция:** план задаёт сигнатуры, файлы, тесты и команды; тела реализации оставлены исполнителю.

## Передача

План — **ЧЕРНОВИК**. До исполнения нужны:

1. принятая спека `.specs/support-agent.md` и тикет `.scratch/support-agent/issues/01-web-chat-kb-escalation.md`;
2. Г3a — проверка supervisor с доказательствами;
3. отдельное «поехали» владельца;
4. выбор режима исполнения: субагенты или одна сессия.
