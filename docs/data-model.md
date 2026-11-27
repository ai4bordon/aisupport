# Модель данных и миграционный план — ИИ-агент поддержки

> Статус: **ЧЕРНОВИК** для Г3a. Фиксирует таблицы и порядок миграций; не является исполняемым SQL.
> Источники: `.specs/support-agent.md`, `GLOSSARY.md`, `adr/0003-postgres-and-tenant-id.md`, `adr/0004-pii-minimization.md`, `adr/0005-approved-knowledge-sources.md`, `adr/0008-shadow-mode.md`.
> База: PostgreSQL 16 + pgvector, одна база, один процесс приложения.

## 1. Решения и допущения

**ДОПУЩЕНИЕ A-DATA-01:** `tenant_id` присутствует во всех таблицах данных и входит в состав уникальных индексов и запросов. Значение определяется сервером из сессии/кода доступа.

**ДОПУЩЕНИЕ A-DATA-02:** все идентификаторы — UUID v4, генерируемые приложением (`gen_random_uuid()` требует `pgcrypto`).

**ДОПУЩЕНИЕ A-DATA-03:** `created_at`/`updated_at` — `timestamptz`, часовой пояс UTC.

**ДОПУЩЕНИЕ A-DATA-04:** размерность эмбеддингов — 1536; модель — `qwen3-embedding-8b` через OpenCode Go (ADR-0013).
**ДОПУЩЕНИЕ A-DATA-05:** векторный поиск используется для БЗ и статей; каталог ищется структурно. Доступ к поиску ограничен разрешёнными циклами одобрения.
## 2. Группы таблиц

| Группа | Таблицы |
|---|---|
| Обращения | `tenants`, `conversations`, `messages`, `escalations`, `promises` |
| Каталог | `products`, `catalog_categories`, `price_rules`, `policy_rules` |
| Клиенты и заказы | `clients`, `orders`, `licenses` |
| База знаний | `kb_documents`, `kb_chunks`, `kb_articles`, `kb_sources` |
| Документы | `templates`, `documents` |
| Трасса и аудит | `agent_steps`, `audit_log` |
| Защита стенда | `usage_counters` |
| Классификация | `intent_taxonomy` |

Итого: **24 таблицы**. Число отличается от «17 таблиц» в макете Ивы: exec добавляет `tenants` как обязательную корневую таблицу, `usage_counters` для серверных счётчиков защиты публичного стенда, `catalog_categories` для дерева категорий фида, `kb_sources` для импортированных источников базы знаний, `catalog_snapshots` и `kb_source_snapshots` для истории снимков по R22, `intent_taxonomy` для классификатора намерений.

## 3. Таблицы

### 3.1 `tenants`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `slug` | text | unique, not null |
| `name` | text | not null |
| `shadow_mode` | boolean | not null, default false |
| `created_at` | timestamptz | not null, default now() |

### 3.2 `conversations`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK `tenants`, not null |
| `channel` | text | not null; `web` или `max` |
| `external_chat_id` | text | null; идентификатор MAX |
| `client_ref` | text | null; маскированная ссылка на клиента |
| `cookie_digest` | text | null; SHA-256 подписи cookie диалога, не сама cookie |
| `status` | text | not null; `open`, `escalate`, `closed` |
| `created_at` | timestamptz | not null, default now() |
| `updated_at` | timestamptz | not null, default now() |

Индексы: unique `(tenant_id, channel, external_chat_id)` для `external_chat_id IS NOT NULL`; `(tenant_id, status, updated_at DESC)`.

### 3.3 `messages`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `conversation_id` | uuid | FK `conversations`, not null |
| `client_message_id` | uuid | not null |
| `role` | text | not null; `client`, `agent`, `manager`, `system` |
| `text_masked` | text | not null; текст с метками ПД |
| `text_original` | text | null; полный текст только для серверной части |
| `sources` | jsonb | not null, default `'[]'::jsonb` |
| `created_at` | timestamptz | not null, default now() |

Индексы: unique `(tenant_id, client_message_id)` для идемпотентности; `(tenant_id, conversation_id, created_at)`.

### 3.4 `escalations`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `conversation_id` | uuid | FK, not null |
| `reason` | text | not null |
| `summary` | text | not null |
| `draft` | text | null |
| `sources` | jsonb | not null, default `'[]'::jsonb` |
| `status` | text | not null; `open`, `closed` |
| `sla_due_at` | timestamptz | null |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, status, created_at DESC)`.

### 3.5 `promises`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `conversation_id` | uuid | FK, not null |
| `text` | text | not null |
| `due_at` | timestamptz | not null |
| `owner` | text | not null |
| `status` | text | not null; `open`, `done`, `overdue`; default `open` |
| `reminded_at` | timestamptz | null; автоматического напоминания нет |
| `created_at` | timestamptz | not null, default now() |
| `source_kind` | text | null; тип источника |
| `source_id` | text | null; идентификатор источника |
| `is_synthetic` | boolean | not null, default false |
| `channel` | text | not null; `max` или `email`, default `max` |
| `contact_email` | text | null; адресат для кабинета менеджера, не передаётся модели/трассе |
| `contact_label` | text | null; метка email для модели/трассы |
| `external_chat_id` | text | null; адресат-диалог MAX |

Индексы: `(tenant_id, status, due_at)` и `(tenant_id, due_at)`.
Источник — фид `Mindbox.yml.gz.xml` заказчика: 136 040 позиций, 1 232 вендора, валюта RUR.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `offer_id` | text | not null; идентификатор позиции в фиде |
| `group_id` | text | null; группировка вариантов одного продукта |
| `name` | text | not null |
| `vendor` | text | null |
| `vendor_url` | text | null |
| `product_url` | text | null |
| `price` | numeric(14,2) | not null, `>= 0`, рубли |
| `old_price` | numeric(14,2) | null |
| `currency_id` | text | not null, default `RUR` |
| `category_id` | text | null |
| `available` | boolean | not null |
| `delivery` | boolean | null |
| `pickup` | boolean | null |
| `description` | text | null |
| `params` | jsonb | not null, default `'{}'::jsonb`; 387 имён параметров, значения хранятся как есть |
| `snapshot_id` | uuid | FK `catalog_snapshots`, not null; снимок фида, из которого взята позиция |
| `status` | text | not null; `approved_by_customer` для позиций фида заказчика, `synthetic` для синтетических |
| `published` | boolean | not null, default false |
| `created_at` | timestamptz | not null, default now() |

Индексы: unique `(tenant_id, offer_id)`; `(tenant_id, published, available)`; полнотекстовый GIN по `name`; B-tree по `(tenant_id, group_id)`; B-tree по `(tenant_id, category_id)`; B-tree по `(tenant_id, vendor)`; B-tree по `(tenant_id, snapshot_id)`.

Повторный импорт обновляет позицию и переводит её на новый снимок; предыдущий снимок остаётся в истории таблицы `catalog_snapshots`.

**Граница поиска:** у позиции каталога нет вектора. Поиск каталога — структурный: точное совпадение `offer_id`, полнотекстовый поиск по `name`, фильтры по `vendor`, `category_id`, `available` и параметрам. Векторный индекс применяется только к базе знаний и статьям.

### 3.7 `catalog_categories`

Дерево категорий фида: 9 311 узлов с `parentId`.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `category_id` | text | not null; идентификатор категории в фиде |
| `parent_id` | text | null; идентификатор родительской категории |
| `name` | text | not null |
| `path` | text | not null; полный путь от корня, через разделитель |

Индекс: unique `(tenant_id, category_id)`; `(tenant_id, parent_id)`.

Полный путь вычисляется при импорте один раз, чтобы подбор по категории не требовал рекурсивных обходов на каждый запрос.

### 3.8 `price_rules`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `product_id` | uuid | FK `products`, not null |
| `segment` | text | not null |
| `min_qty` | integer | not null, default 1 |
| `discount_max` | numeric(5,2) | not null, проценты 0–100 |
| `postpay_allowed` | boolean | not null, default false |
| `valid_from` | timestamptz | not null |
| `valid_to` | timestamptz | null |

Индекс: `(tenant_id, product_id, segment, valid_from)`.

### 3.9 `policy_rules`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `rule_key` | text | not null |
| `threshold` | numeric(12,4) | null |
| `action` | text | not null; `allow` или `escalate` |
| `note` | text | null |
| `valid_from` | timestamptz | not null |
| `valid_to` | timestamptz | null |

Индекс: unique `(tenant_id, rule_key, valid_from)`.

### 3.10 `clients`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `name` | text | not null |
| `inn` | text | null |
| `segment` | text | not null |
| `manager_id` | text | null |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, name)`; уникальность ИНН не фиксируется, поскольку загрузка моковых данных допускает неполные записи.

### 3.11 `orders`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `client_id` | uuid | FK `clients`, not null |
| `status` | text | not null |
| `paid_at` | timestamptz | null |
| `total` | integer | not null, `>= 0` |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, client_id, created_at DESC)`.

### 3.12 `licenses`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `product_id` | uuid | FK `products`, not null |
| `client_id` | uuid | FK `clients`, not null |
| `keys_total` | integer | not null, `>= 0` |
| `keys_used` | integer | not null, `>= 0` |
| `expires_at` | timestamptz | not null |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, client_id, expires_at)`.

### 3.13 `kb_documents`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `filename` | text | not null |
| `mime_type` | text | not null |
| `size_bytes` | integer | not null, `> 0` |
| `storage_path` | text | not null |
| `status` | text | not null; `pending`, `published`, `rejected`, `error` |
| `chunks_count` | integer | not null, default 0 |
| `created_at` | timestamptz | not null, default now() |
| `approved_at` | timestamptz | null |
| `parse_status` | text | not null; `not_parsed`, `parsed`, `failed` |
| `parse_error` | text | null |
| `provenance` | jsonb | not null, default `'{}'` |
| `source_kind` | text | not null; `manager_upload` |
| `source_url` | text | null |
| `snapshot_hash` | text | null |
| `approved_by` | text | null |
| `rejected_reason` | text | null |
| `parsed_at` | timestamptz | null |
| `failed_at` | timestamptz | null |
| `retry_count` | integer | not null, default 0 |
| `last_attempt_at` | timestamptz | null |
| `extracted_chars` | integer | not null, default 0 |

Индексы: `(tenant_id, status, created_at DESC)`, `(tenant_id, parse_status, created_at DESC)`.

`status` отвечает за публикацию, `parse_status` — за разбор: результат разбора отделён от того, одобрен ли материал. `error` означает, что разбор или индексация не удались: материал недоступен поиску, но виден менеджеру и может быть обработан повторно (`retry_count`, `last_attempt_at`). Провенанс загрузки живёт здесь, а не в `kb_sources`: у материала менеджера нет URL источника, а `kb_sources.origin` ограничен `docs_site`/`store_page`.

### 3.14 `kb_chunks`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `document_id` | uuid | FK `kb_documents`, null |
| `article_id` | uuid | FK `kb_articles`, null |
| `chunk_no` | integer | not null, `>= 0` |
| `page_no` | integer | null, `>= 1` |
| `text` | text | not null |
| `search_vector` | tsvector | not null |
| `embedding` | vector(1536) | not null |
| `created_at` | timestamptz | not null, default now() |

Индексы: unique `(tenant_id, document_id, chunk_no)` для чанков документа; unique `(tenant_id, article_id, chunk_no)` для чанков статьи; HNSW `(embedding vector_cosine_ops)`; GIN `(search_vector)`.

Ограничение: `CHECK (num_nonnulls(document_id, article_id) = 1)` — чанк принадлежит либо документу, либо статье, но не обоим и ни одному.

### 3.15 `kb_articles`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `title` | text | not null |
| `body_md` | text | not null |
| `status` | text | not null; `draft`, `pending_review`, `approved`, `published`, `rejected` |
| `version` | integer | not null, default 1 |
| `valid_from` | timestamptz | not null |
| `valid_to` | timestamptz | null |
| `owner` | text | null |
| `created_at` | timestamptz | not null, default now() |
| `approved_at` | timestamptz | null |
| `conversation_id` | uuid | FK `conversations`, null; исходный диалог материала |
| `source_message_ids` | jsonb | not null, default `'[]'::jsonb`; сообщения диалога, вошедшие в материал |
| `source_excerpt` | text | null; выдержка из исходного материала |
| `approved_by` | text | null; менеджер, принявший решение |
| `reviewed_at` | timestamptz | null; время решения менеджера |
| `published_at` | timestamptz | null; с этого момента статья доступна поиску |

Индекс: `(tenant_id, status, valid_from, valid_to)`; `(tenant_id, status, created_at DESC)` — очередь проверки материалов.

Состояния: `pending_review` — материал собран из диалога и ждёт решения менеджера, в поиск не попадает; `approved` — менеджер одобрил, публикация ещё не выполнена, в поиск не попадает; `published` — доступна поиску базы знаний; `rejected` — решение принято, материал не используется; `draft` — служебное состояние.

### 3.16 `templates`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `kind` | text | not null; `quote`, `invoice`, `response` |
| `name` | text | not null |
| `body` | text | not null |
| `placeholders` | jsonb | not null, default `'[]'::jsonb` |
| `version` | integer | not null, default 1 |
| `is_active` | boolean | not null, default false |

Индекс: unique `(tenant_id, kind, name, version)`; `(tenant_id, kind, is_active)`.

### 3.17 `documents`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `conversation_id` | uuid | FK, not null |
| `kind` | text | not null; `quote`, `invoice` |
| `number` | text | not null |
| `amount` | integer | not null, `>= 0` |
| `vat` | integer | not null, `>= 0` |
| `valid_until` | timestamptz | null |
| `pdf_path` | text | null |
| `created_at` | timestamptz | not null, default now() |

Индекс: unique `(tenant_id, kind, number)`.

### 3.18 `agent_steps`

| Колонка |Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `conversation_id` | uuid | FK, not null |
| `node` | text | not null |
| `endpoint` | text | null |
| `tokens_in` | integer | not null, default 0 |
| `tokens_out` | integer | not null, default 0 |
| `cost_rub` | numeric(12,4) | not null, default 0 |
| `latency_ms` | integer | not null, default 0 |
| `metadata` | jsonb | not null, default `'{}'::jsonb` |
| `source_ids` | jsonb | not null, default `'[]'::jsonb`; безопасные id опубликованных источников |
| `outcome` | text | null; `respond` или `escalate` |
| `model` | text | null; идентификатор модели без ключа |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, conversation_id, created_at)`.

### 3.19 `audit_log`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `actor` | text | not null |
| `action` | text | not null |
| `entity` | text | not null |
| `before` | jsonb | null |
| `after` | jsonb | null |
| `created_at` | timestamptz | not null, default now() |

Индекс: `(tenant_id, entity, created_at DESC)`.

### 3.20 `usage_counters`

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `scope` | text | not null; `requests_minute`, `dialogs_daily`, `model_budget_hour`, `model_budget_day` |
| `bucket_key` | text | not null; IP или час/сутки |
| `counter` | bigint | not null, default 0 |
| `spend_rub` | numeric(12,4) | not null, default 0 |
| `window_start` | timestamptz | not null |
| `updated_at` | timestamptz | not null, default now() |

Индекс: unique `(tenant_id, scope, bucket_key, window_start)`.

Счётчики живут в базе, а не в памяти процесса: перезапуск не обнуляет суточный счётчик диалогов. Счётчик запросов в минуту считается по IP, счётчик диалогов — на стенд, счётчики бюджета — по часу и суткам.

### 3.21 `intent_taxonomy`

Таксономия намерений из переписок службы поддержки заказчика. Девять категорий, проверено по файлам `чаты поддержки/buy_part_1..3_masked.txt`.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `code` | text | not null; машинное имя категории |
| `title` | text | not null; название категории из переписок |
| `description` | text | null |
| `requires_escalation` | boolean | not null, default false |
| `ask_before_answer` | boolean | not null, default false |
| `sort_order` | integer | not null, default 0 |

Индекс: unique `(tenant_id, code)`.

Категории: «Просто цена конкретного товара», «Конфигурация / спецификация», «Доступность вендора (можно ли купить)», «Скидки / льготы / спецусловия», «Физлицо / самозанятый / срок», «Прочее (покупка)», «Госзакупки / процедуры», «Счет / КП как документ (с реквизитами)», «Follow-up / не дозвонился».

Категории используются дважды: классификатор определяет намерение, аналитика показывает пробелы базы знаний по намерениям, на которые чаще всего не найдено подтверждённого ответа.

### 3.22 `kb_sources`

Источники базы знаний заказчика: сайт `docs.softline.com` и страница `store.softline.ru/delivery_info/`.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `origin` | text | not null; `docs_site`, `store_page` |
| `source_url` | text | not null |
| `title` | text | not null |
| `section_path` | text | null; путь разделов, например `subscriptions / payment` |
| `content_text` | text | not null; извлечённый текст без разметки |
| `raw_html_path` | text | null; путь к кэшу сырого HTML |
| `crawled_at` | timestamptz | not null; дата получения |
| `snapshot_hash` | text | null; хеш снимка обхода |
| `status` | text | not null; `approved_by_customer` для импортированных источников заказчика, `published` для одобренных менеджером, `pending` для загруженных, `draft` для черновиков статей, `rejected` |
| `provenance` | text | null; описание происхождения, например `docs.softline.com, обход 26.11.2026` |
| `created_at` | timestamptz | not null, default now() |

Индекс: unique `(tenant_id, source_url)`; `(tenant_id, origin, status)`.

**Провенанс:** источник, импортированный с сайта заказчика, получает статус `approved_by_customer` с провенансом и не проходит менеджерское одобрение. Материал, загруженный менеджером, проходит одобрение по общему правилу R6/R7. Импорт выполняется один раз в спринте; при обновлении сайта источник обновляется с сохранением провенанса. Материалы, загруженные менеджером через интерфейс, требуют одобрения — для них провенанс пустой, а `status=pending`.

## 4. Связи

| Связь | Назначение |
|---|---|
| `conversations` → `messages` → `agent_steps` | История обращения и трасса |
| `products` → `price_rules` → расчёт кодом | Цена и правила скидок |
| `kb_documents` → `kb_chunks` → `kb_articles` | Загрузка файла и черновик из диалога |
| `templates` → `documents` | Шаблон и созданный PDF |
| `policy_rules` → `escalations` | Полномочия и передача человеку |
| `conversations` → `promises` | Обещание в рамках обращения |

## 4.1 Провенанс по R22

Каждый источник знаний и каталога хранит провенанс: путь или URL, дату получения, идентификатор снимка и статус.

- Фид заказчика: `source_url` живого фида, `feed_date` из содержимого фида, `fetched_at`, `snapshot_hash`, `status=approved_by_customer`.
- Сайт базы знаний: `source_url` страницы, `crawled_at`, `snapshot_hash`, `provenance`, `status=approved_by_customer`.
- Синтетические записи помечаются `status=synthetic` и не смешиваются со снимками заказчика.
- Новый снимок не уничтожает предыдущий: история хранится в `catalog_snapshots` и `kb_source_snapshots`.
- Ответ агента и запись трассы указывают источник и дату или идентификатор снимка.

## 5. Правила доступа

- `tenant_id` добавляется серверным репозиторием ко всем запросам; клиентский `tenant_id` отбрасывается.
- Модули не видят соседние таблицы напрямую: доступ идёт через публичный API модуля.
- Неодобренные материалы не попадают в поисковую выдачу даже при прямом `kb_chunks` запросе: условие допуска задаёт read-модуль `knowledge`.
- ПД: `text_original` и таблица соответствий масок недоступны модели; модель получает только `text_masked` и метки.

## 6. Миграционный план

Миграции выполняются `node-pg-migrate`; каждая миграция — SQL-файл в `db/migrations/`. Номера закреплены за срезами волны 1: ядро 100–999, каталог 1000–1999, база знаний 2000–2999, документы 3000–3999, доступ 4000–4999, каналы 5000–5999, волна 2 — 6000–6999. Номер выбирает exec, агент числа не назначает. Миграции обратимы и выполняются в одной транзакции, если операция не требует `CREATE EXTENSION CONCURRENTLY`.

| 100 | `100_extensions.sql` | `pgcrypto`, `vector` | — | ядро |
| 110 | `110_tenants.sql` | `tenants` | 100 | ядро |
| 120 | `120_conversations.sql` | `conversations`, `messages` | 110 | ядро |
| 130 | `130_knowledge_core.sql` | `kb_documents`, `kb_articles`, `kb_chunks`, `agent_steps`, индексы HNSW/GIN | 110, 120 | ядро |
| 140 | `140_escalations_promises.sql` | `escalations`, `promises` | 120 | ядро |
| 150 | `150_policy_rules.sql` | `policy_rules` | 110 | ядро |
| 160 | `160_audit.sql` | `audit_log` | 110 | ядро |
| 170 | `170_intent_taxonomy.sql` | `intent_taxonomy` + начальные девять категорий | 110 | ядро |
| 1000 | `1000_catalog.sql` | `products`, `catalog_categories`, `price_rules` | 110 | каталог |
| 1010 | `1010_clients_orders_licenses.sql` | `clients`, `orders`, `licenses` | 110 | каталог |
| 1020 | `1020_catalog_snapshots.sql` | `catalog_snapshots` | 110 | каталог |
| 2000 | `2000_kb_sources.sql` | `kb_sources`, `kb_source_snapshots` | 110 | база знаний |
| 2100 | `2100_kb_document_upload.sql` | `kb_documents`: разбор, ошибка и провенанс загрузки | 130 | загрузка документов |
| 3000 | `3000_templates_documents.sql` | `templates`, `documents` | 120 | документы |
| 4000 | `4000_usage_counters.sql` | `usage_counters` | 110 | доступ |
| 5000 | `5000_channel_state.sql` | `channel_state` | 120 | каналы |
| 5100 | `5100_conversation_mask.sql` | `conversation_mask` — соответствия меток ПД по диалогам | 120 | ядро |
| 5200 | `5200_chunk_embedding_model.sql` | `kb_chunks.embedding_model` — модель индекса вектора | 130 | база знаний |
| 5300 | `5300_conversation_slots.sql` | `conversation_slots` — состояние подбора | 120 | ядро |
| 6300 | `6300_shadow_mode_queue.sql` | `escalations.channel`, `result`, `trace_ref`; удаление `channel_state.shadow_mode` | 120, 140, 5000 | режим тени |
| 6301 | `6301_shadow_flag.sql` | `escalations.is_shadow` — признак результата режима тени | 6300 | режим тени |
| 6400 | `6400_runtime_safety.sql` | `agent_steps.step_key` — идемпотентный ключ шага трассы | 130 | устойчивость |
| 6500 | `6500_promises_provenance.sql` | provenance, канал и адресат/контакт `promises`; индекс срока | 140 | обещания |
| 6600 | `6600_article_draft_review.sql` | провенанс и жизненный цикл черновиков `kb_articles` | 130 | статьи |
Миграционная таблица выше охватывает все 24 SQL-файла, присутствующие в `db/migrations/`; строки упорядочены по номеру, а 6300–6600 отражают существующие миграции волны 2. Диапазон 51xx–53xx занят расширениями ядра и БЗ. Блокировка диалога в тикете 10 обеспечивается кодом, отдельной миграции не имеет.
Тикеты 03 и 04 используют отдельные выделенные номера: загрузка документов — 2100; жизненный цикл черновиков статей — 6600. Новые тикеты эти номера не занимают.

### 6.1 Порядок первого тикета

Первый вертикальный срез использует миграции `100`–`150`:

1. `tenants`;
2. `conversations`;
3. `messages`;
4. `kb_documents`, `kb_articles`, `kb_chunks`;
5. `agent_steps`;
6. `escalations`, `promises`;
7. `policy_rules`.

`promises` создаётся в той же миграции `140`, потому что ссылается на `conversations`. Загрузка файлов, каталог, документы, клиенты, заказы, лицензии и аудит добавляются отдельными тикетами; колонки создаются в одной миграции с таблицами, чтобы не оставлять схему в промежуточном состоянии.

### 6.2 Проверка миграций

```bash
npm run db:migrate:up
npm run db:migrate:status
npm run db:migrate:down -- --count 1
npm run db:migrate:up
```

После каждого шага — тест, проверяющий наличие таблиц, ограничений и индексов в тестовой базе.

## 7. Тестовые данные

- `tenants`: `demo-tenant`.
- Каталог и статьи БЗ: синтетические значения с явной пометкой «допущение» в тестовых данных.
- Вектор эмбеддинга в тестах детерминированный; тесты не вызывают внешний API векторов.
- Ключ модели, ключ векторов и токен MAX — только переменные окружения/секретница.

## 8. Риски

| Риск | Влияние | Смягчение |
|---|---|---|
| Служба Docker недоступна на машине | Нельзя поднять Postgres локально | Запустить Docker Desktop до задачи 1; если невозможно — эскалация владельцу, не подмена БД данными в памяти |
| `CREATE EXTENSION vector` требует прав | Миграция 100 падает | Образ `pgvector/pgvector:pg16`; проверить до задачи 1 |
| Эмбеддинги недоступны | Поиск БЗ не работает | Ключ выдаётся владельцем; до выдачи — детерминированная фикстура, живой поиск обязателен в доказательствах |
| Размер документа > 50 МБ | Загрузка отклоняется | Ограничение до чтения файла в память |
### 3.23 `catalog_snapshots`

История снимков товарного фида. Регламент обновления — раз в сутки, ручной запуск импорта; планировщик в прототипе не строится.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `source_url` | text | not null; живой источник истины |
| `feed_date` | timestamptz | null; дата фида из его содержимого |
| `fetched_at` | timestamptz | not null; дата получения |
| `snapshot_hash` | text | not null; хеш снимка |
| `offers_count` | integer | not null, default 0 |
| `categories_count` | integer | not null, default 0 |
| `is_current` | boolean | not null, default false |
| `source_kind` | text | not null; `live_feed` или `local_snapshot` |

Индекс: unique `(tenant_id, snapshot_hash)`; `(tenant_id, is_current)`.

Предыдущие снимки не удаляются: новый импорт создаёт новую запись и переключает `is_current`, поэтому история провенанса сохраняется.

### 3.24 `kb_source_snapshots`

История снимков импортированных источников базы знаний.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK, not null |
| `source_id` | uuid | FK `kb_sources`, not null |
| `snapshot_hash` | text | not null |
| `provenance` | text | not null |
| `crawled_at` | timestamptz | not null |
| `status` | text | not null |
| `valid_from` | timestamptz | not null |
| `valid_to` | timestamptz | null; закрывается, когда приходит следующий снимок |

Индекс: unique `(tenant_id, source_id, snapshot_hash)`; `(tenant_id, source_id, valid_from DESC)`.

