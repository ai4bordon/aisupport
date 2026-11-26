# Табло волны 1 — ИИ-агент поддержки

> Статус: **волна 1 запущена**. Спека и контракт заморожены; каждый срез исполняется в своём worktree и своей ветке.
> План волны: `docs/plans/wave-1.md`. Правила заморозки: `docs/api-contract.md` §0.

## Общие правила

| Правило | Значение |
|---|---|
| Контракт | `docs/api-contract.md` заморожен. Изменение — только через exec с записью в дом |
| Модель данных | `docs/data-model.md` заморожена |
| Общие файлы | `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, роутер — правятся только exec после слияния волны |
| Миграции | Номера закреплены exec, агент числа не назначает |
| Тесты | Red → Green → Refactor. Падающий тест обязателен: сначала тест, потом код |
| Ресурсы | 4 vCPU, 8 ГБ. Юнит-тесты агента — пул из 2 форков. Тяжёлые прогоны (12, 13) — по одному |
| Токены и ключи | Только переменные окружения. Не в репозитории, журналах, evidence и переписке |
| Базы | Своя база на срез, имя с суффиксом тикета. Порт 5433 локальный |

## Локальная база

Подъём и миграции описаны в `db/README.md`. Общий шаблон: контейнер `pgvector/pgvector:pg16`, порт 5433, база `support_agent_<тикет>`, расширение `vector` создаётся миграцией `100`.

## Срезы

| Срез | Тикет | Агент | Ветка | Worktree | Шаги плана | Каталог | Команда проверки | База |
|---|---|---|---|---|---|---|---|---|
| Ядро и веб-чат | 01 | agent-core | `slice/01-core-web-chat` | `.worktrees/01-core-web-chat` | `docs/plans/01-web-chat-kb-escalation.md` — задачи 1–6 | `src/core/**`, `src/db/**`, `src/contracts/**`, `src/app/api/chat/**`, `src/app/api/agent/**`, `src/app/api/health/**`, `src/app/api/kb/**`, `src/app/widget/**`, `src/modules/knowledge/index.ts`, `src/modules/knowledge/search.ts`, `src/modules/policy/**`, `src/modules/telemetry/**` | `npm run test -- tests/integration/01-web-chat-kb-escalation.test.ts` | `support_agent_01` |
| Документы: КП и счёт | 02 | agent-docs | `slice/02-quote-invoice` | `.worktrees/02-quote-invoice` | `docs/plans/02-quote-invoice.md` — задачи 1–2 | `src/modules/documents/**`, `src/app/api/docs/**` | `npm run test -- tests/integration/02-quote-invoice.test.ts` | `support_agent_02` |
| MAX-адаптер | 05 | agent-max | `slice/05-max-polling` | `.worktrees/05-max-polling` | `docs/plans/05-max-polling-adapter.md` — задачи 1–2 | `src/channels/max/**`, `src/app/api/max/**` | `npm run test -- tests/integration/05-max-polling-adapter.test.ts` | `support_agent_05` |
| Барьер доступа к стенду | 11 | agent-access | `slice/11-access-guard` | `.worktrees/11-access-guard` | `docs/plans/11-public-demo-access.md` — задачи 1–2 | `src/modules/access/**`, `src/modules/limits/**`, `src/app/access/**`, `src/app/api/access/**` | `npm run test -- tests/integration/11-public-demo-access.test.ts` | `support_agent_11` |
| Импорт фида каталога | 12 | agent-feed | `slice/12-import-feed` | `.worktrees/12-import-feed` | `docs/plans/12-import-catalog-feed.md` — задачи 1–2 | `src/import/catalog/**`, `src/modules/catalog/**`, `scripts/import-feed.ts` | `npm run test -- tests/integration/12-import-catalog-feed.test.ts` | `support_agent_12` |
| Импорт базы знаний с сайта | 13 | agent-docs-site | `slice/13-import-knowledge` | `.worktrees/13-import-knowledge` | `docs/plans/13-import-knowledge-site.md` — задачи 1–2 | `src/import/knowledge/**`, `scripts/import-docs.ts` | `npm run test -- tests/integration/13-import-knowledge-site.test.ts` | `support_agent_13` |

## Диапазоны миграций

| Срез | Диапазон | Миграции |
|---|---|---|
| 01 ядро | 100–999 | 100 `extensions`, 110 `tenants`, 120 `conversations`, 130 `knowledge_core`, 140 `escalations_promises`, 150 `policy_rules`, 160 `audit`, 170 `intent_taxonomy` |
| 02 документы | 3000–3999 | 3000 `templates_documents` |
| 05 MAX | 5000–5999 | 5000 `channel_state` |
| 11 доступ | 4000–4999 | 4000 `usage_counters` |
| 12 фид | 1000–1999 | 1000 `catalog`, 1010 `clients_orders_licenses`, 1020 `catalog_snapshots` |
| 13 база знаний | 2000–2999 | 2000 `kb_sources` |
| Волна 2 | 6000–6999 | 6000 `agent_settings`, 6100 `analytics` |

## Порядок запуска

| Очередь | Срезы | Почему |
|---|---|---|
| Параллельно | 01, 02, 05, 11 | Лёгкие: только юнит-тесты, своя база, тяжёлых прогонов нет |
| Последовательно | 12, затем 13 | Тяжёлые: импорт 136 040 позиций и обход сайта. По одному, чтобы не уронить 4 vCPU |

## Слияние

1. Срез сдаёт evidence: список коммитов, команда проверки, код завершения, границы изменённых файлов.
2. Exec проверяет, что diff агента не выходит за каталог среза.
3. Exec выполняет интеграционные тесты волны.
4. Exec вносит общие правки: роутер, корневой конфиг, подключение барьера доступа и MAX к ядру.
5. Слияние ветки среза в `main` — через exec.

## Точки подключения, которые делает exec при слиянии

| Что | Где | Почему не агент |
|---|---|---|
| Проверка доступа перед `POST /v1/chat` | `src/app/api/chat/route.ts` | Общий роутер, затрагивает срез 01 |
| Проверка доступа перед отправкой в MAX | `src/channels/max/**` | Точка между срезами 05 и 11 |
| Подключение адаптера MAX к ядру | `src/core/**` | Ядро принадлежит срезу 01 |
| Роутер и корневой конфиг | `src/app/**`, `package.json` | Общие файлы, правятся после слияния |

## Риски волны

| Риск | Смягчение |
|---|---|
| Docker daemon не запущен на машине | Поднять Docker Desktop до Task 1; без него срезу 01 база не поднимется |
| Импорт фида и обход сайта одновременно | Строго последовательно: сначала 12, потом 13 |
| Пул тестов при шести агентах | `vitest --pool=forks --poolOptions.forks.maxForks=2` |
| Агент правит общую поверхность | Стоп и вопрос exec; правка контракта останавливает срез |
| Расхождение с шаблоном КП заказчика | Тикет 02: поля сверяются с `Шаблон КП ПАО Софтлайн.pdf`, расхождение блокирует документ |
| MAX недоступен без модерации | Тикет 05: при недоступности — BLOCKED, имитация не выдаётся за живую проверку |
