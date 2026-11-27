# Проверка и публикация черновиков статей из диалогов: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до приёма на Г3a и отдельного «поехали» владельца.**

**Цель:** дать менеджеру отдельный поток создания статьи из материалов диалога, дождаться явного одобрения и только после этого сделать статью доступной поиску базы знаний.

**Тикет:** `.scratch/support-agent/issues/04-article-draft-review.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`), требование R7; ADR-0005 (раздельные потоки одобрения документов и статей).

**Контракт:** `docs/api-contract.md` §1 (единый HTTP API и публичные `index.ts` модулей), §2 (ошибки и `snake_case` на HTTP-границе), §3 (маршруты `POST /kb/drafts`, `POST /kb/drafts/{id}/approve`), §6 (в выдачу поиска попадают только опубликованные источники).

**Данные:** `docs/data-model.md` §3.2 (`conversations`), §3.13 (`kb_documents`), §3.14 (`kb_chunks`), §3.15 (`kb_articles`).

**Технологии:** Node.js 22 LTS, TypeScript, PostgreSQL 16 + pgvector, Next.js Route Handlers, Vitest.

## Команда проверки

`npm run test -- tests/integration/04-article-draft-review.test.ts`

Команда обязательна к приёмке среза: интеграционный тест собирает миграцию, операции черновиков, защиту менеджера и поиск в одном сценарии.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Реальное состояние проверено: `kb_articles` уже создана миграцией `db/migrations/130_knowledge_core.sql`. Сейчас у неё есть `title`, `body_md`, `status text CHECK (status IN ('draft','published','rejected'))`, `version`, `valid_from`, `valid_to`, `owner`, `created_at`, `approved_at`; индекс `(tenant_id, status, valid_from, valid_to)`. Таблица `kb_chunks` допускает ровно одного владельца — `document_id` либо `article_id`. Миграция среза не создаёт новую таблицу статей и не дублирует `title`/`body_md`: она расширяет существующую сущность полями провенанса и недостающими состояниями.
- Миграция этого среза — `db/migrations/6600_article_draft_review.sql`. Номер свободен: в `db/migrations/` заняты `1000`, `100`, `1010`, `1020`, `110`, `120`, `130`, `140`, `150`, `160`, `170`, `2000`, `3000`, `4000`, `5000`, `5100`, `5200`, `5300`; номер `6600` свободен и не совпадает с миграциями плана 03 (2xxx) и плана 10 (6400). Номер закрепляет exec; при согласовании меняется на свободный 6xxx без изменения содержимого.
- Срез владеет: `db/migrations/6600_article_draft_review.sql`, новым модулем `src/modules/article-drafts/**`, маршрутами `src/app/api/kb/drafts/**`, тестом `tests/integration/04-article-draft-review.test.ts`.
- Общие поверхности не меняются без координации с exec: `docs/api-contract.md`, `docs/data-model.md`, `src/core/run.ts` (если не оговорённое ниже), `src/modules/knowledge/**`, `src/modules/access/**`, роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`. В частности, поиск `src/modules/knowledge/search.ts` уже содержит обязательный фильтр `a.status = 'published'`; срез не дублирует и не ослабляет этот фильтр.
- Сущность `kb_documents` и её переходы `pending → published/rejected` не меняются. Операции и маршруты черновиков не принимают `document_id`, не вызывают модуль загрузки документов и не меняют его статус.
- Все менеджерские операции проходят через существующий барьер `checkManagerAccess` из `src/modules/access/index.ts`; клиентская cookie доступа сама по себе не даёт права создавать, одобрять или публиковать статьи.
- Пул тестовых процессов ограничен: `vitest --pool=forks --poolOptions.forks.maxForks=2`.

## Связь критериев приёмки с шагами

| AC | Что проверяет | Шаги |
|---|---|---|
| 1 | Менеджер создаёт черновик со ссылкой на диалог/материал и видит статус ожидания | 1, 2, 4, 7 |
| 2 | Ожидающий и отклонённый черновики отсутствуют в поиске | 1, 3, 4, 7 |
| 3 | После утверждения и публикации поиск возвращает статью, содержимое и ссылку на источник | 4, 5, 7, 8 |
| 4 | У статьи отдельные `create`/`approve`/`publish` и отдельный API, документы не публикуются случайно | 1, 4, 6, 7 |
| 5 | До утверждения агент не ссылается на черновик и не использует его | 2, 3, 4, 5, 7 |

## Шаги

### Шаг 1. Миграция: провенанс диалога и состояния проверки статьи

- [ ] Создать `db/migrations/6600_article_draft_review.sql` (Up): расширить CHECK статуса `kb_articles` значениями `pending_review`, `approved`; добавить `conversation_id uuid NULL REFERENCES conversations(id)`, `source_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb`, `source_excerpt text NULL`, `approved_by text NULL`, `reviewed_at timestamptz NULL`, `published_at timestamptz NULL`; добавить индекс `kb_articles_tenant_review_status_idx ON kb_articles (tenant_id, status, created_at DESC)`. Существующие `title`, `body_md`, `version`, `valid_from`, `valid_to`, `owner`, `created_at`, `approved_at` сохраняются. Down: удалить добавленный индекс и колонки, затем вернуть CHECK к `('draft','published','rejected')`.
- [ ] Зафиксировать семантику состояний в комментариях миграции: `pending_review` — материал создан и ждёт менеджера; `approved` — одобрен, но ещё не опубликован; `published` — доступен поиску; `rejected` — отклонён и никогда не индексируется; `draft` — служебное состояние, не используемое потоком тикета.
- [ ] Применить: `npm run db:migrate:up` → в выводе `применено: 6600_article_draft_review.sql`; проверить `kb_articles` и новый индекс.
- [ ] Проверить откат: `npm run db:migrate:down` → добавленные поля и состояния исчезают, исходные данные не теряются; затем применить миграцию снова.

### Шаг 2. Падающий тест: менеджер создаёт ожидающий черновик из диалога

- [ ] **Падающий тест** `tests/integration/04-article-draft-review.test.ts`: подготовить `conversations` и сообщения диалога; запрос менеджера на создание черновика с `conversation_id`, `source_message_ids`, `source_excerpt`, `title`, `body_md` даёт `201`, а запись в `kb_articles` имеет `status='pending_review'`, указанный `conversation_id`, исходные `source_message_ids` и `source_excerpt`.
- [ ] **Падающий тест** на барьер: запрос без менеджерской cookie и запрос с только клиентской cookie получают `401`; запись в `kb_articles` не создаётся.
- [ ] **Падающий тест** на изоляцию источника: `conversation_id` должен существовать и принадлежать тому же `tenant_id`, что и создаваемый черновик; `source_message_ids` — непустой массив UUID существующих сообщений выбранного диалога. Несвязанный диалог или сообщение отклоняются `400 validation_error` без записи.
- [ ] **Зелёный тест:** после реализации шага 4 эти кейсы проходят; до реализации — падение из-за отсутствующего модуля/маршрута.

### Шаг 3. Падающий тест: ожидающий и отклонённый черновик не попадают в поиск

- [ ] **Падающий тест** `tests/integration/04-article-draft-review.test.ts`: создать статью со `status='pending_review'`, индексный чанк с `article_id` этой статьи и уникальным текстом; вызов публичного `search` из `src/modules/knowledge` по этому тексту не возвращает статью. Затем перевести запись в `status='rejected'` и повторить поиск — результат также пуст.
- [ ] **Падающий тест** на агентный ответ: результат `runAgent`/`src/core/run.ts` для вопроса по уникальному тексту черновика не содержит цитату, `answer.sources` не содержит `kind='kb_article'` с id черновика, а если подтверждённого источника нет — формируется эскалация, а не ответ на основе черновика.
- [ ] Проверить причину изоляции по коду: существующий поиск уже допускает статью только при `a.status = 'published'`; тест фиксирует, что новые состояния не расширяют этот allowlist и не обходят `src/modules/knowledge/search.ts`.
- [ ] **Зелёный тест:** после реализации шагов 4–5 ожидающий и отклонённый черновики отсутствуют и в прямом поиске, и в источниках агентного ответа.

### Шаг 4. Отдельный модуль операций `create`/`approve`/`publish`

- [ ] Создать `src/modules/article-drafts/types.ts` (создаваемый файл): `ArticleDraftStatus = "pending_review" | "approved" | "published" | "rejected"`, `ArticleDraftInput`, `ArticleDraftRecord`, `ApproveArticleDraftInput`, `PublishArticleDraftInput`, `RejectArticleDraftInput`. Вход содержит `tenantId`, `actor`, `conversationId`, `sourceMessageIds`, `sourceExcerpt`, `title`, `bodyMd`; запись возвращает `id`, `status`, `conversationId`, `sourceMessageIds`, `sourceExcerpt`, `title`, `bodyMd`, timestamps.
- [ ] Создать `src/modules/article-drafts/repository.ts` (создаваемый файл): операции чтения/записи только `kb_articles` и `kb_chunks`; `pg` не выходит за пределы модуля.
- [ ] Создать `src/modules/article-drafts/service.ts` (создаваемый файл) с собственными операциями: `createArticleDraft(input): Promise<ArticleDraftRecord>` — создаёт только `pending_review`; `approveArticleDraft(input): Promise<ArticleDraftRecord>` — допускает только `pending_review → approved`, фиксирует `approved_by`, `reviewed_at`, `approved_at`; `publishArticleDraft(input): Promise<ArticleDraftRecord>` — допускает только `approved → published`, фиксирует `published_at`, `valid_from`; `rejectArticleDraft(input): Promise<ArticleDraftRecord>` — допускает только `pending_review → rejected`; `getArticleDraft(tenantId, id): Promise<ArticleDraftRecord | null>`.
- [ ] Повторная операция над состоянием, которого нет в переходах, возвращает доменную ошибку `conflict`; неверный `tenant_id` не раскрывает существование записи. Публикация не принимает `document_id` и не обновляет `kb_documents`.
- [ ] Индексация: `publishArticleDraft` создаёт или обновляет чанки статьи в `kb_chunks` с `article_id`, `search_vector`, `embedding` и `embedding_model` текущей модели; до публикации чанки статьи не создаются. Публикация должна быть транзакционной: ошибка индексации не оставляет опубликованную статью без поисковых чанков.
- [ ] Создать `src/modules/article-drafts/index.ts` (создаваемый файл) — единственная публичная точка модуля. Экспортировать операции и типы, но не `repository.ts`.
- [ ] **Зелёный тест:** `npx vitest run tests/integration/04-article-draft-review.test.ts` — операции проходят, а до утверждения и после отклонения поиск пуст.

### Шаг 5. Падающий тест: после публикации поиск возвращает статью и ссылку на источник

- [ ] **Падающий тест** `tests/integration/04-article-draft-review.test.ts`: создать и одобрить черновик, затем вызвать `publishArticleDraft`; публичный `search` по уникальному тексту статьи возвращает `kind='kb_article'`, `articleId` созданной статьи, её `title` и `text`.
- [ ] **Падающий тест** на ссылку на источник: результат поиска содержит непустой `location`, однозначно указывающий на исходный диалог/материал статьи (например, `диалог <conversation_id>`), а `articleId` совпадает с id черновика. Провенанс хранится в `kb_articles.source_message_ids`/`source_excerpt` и не подменяется URL, которого нет в исходном материале.
- [ ] **Падающий тест** на агентную цитату: после публикации `runAgent`/`src/core/run.ts` возвращает `outcome='respond'`, текст ответа опирается на найденную статью, а `answer.sources` содержит `kind='kb_article'` и id статьи; URL не вставляется в клиентский текст.
- [ ] Проверить обе ветви поиска, потому что они независимы: векторную и полнотекстовую (`tsvector`). Обе обязаны использовать тот же allowlist `status='published'`.
- [ ] **Зелёный тест:** после реализации шага 4 поиск и агентный ответ используют опубликованный черновик, а ожидающий/отклонённый — нет.

### Шаг 6. Отдельный API черновиков и защита от смешения с документами

- [ ] Создать `src/app/api/kb/drafts/route.ts` (создаваемый файл): `POST` создаёт черновик. Перед бизнес-логикой вызывается `checkManagerAccess({ cookieHeader: request.headers.get("cookie") })`; при `allowed=false` возвращается `401 unauthorized` по `accessHttpStatus`. Тело: `conversation_id`, `source_message_ids`, `source_excerpt`, `title`, `body_md`; `tenant_id` берётся сервером. Ответ `201`: `{ id, status: "pending_review", conversation_id, source_message_ids, source_excerpt, title, body_md, created_at }`.
- [ ] Создать `src/app/api/kb/drafts/[id]/approve/route.ts` (создаваемый файл): `POST` за барьером `checkManagerAccess` вызывает `approveArticleDraft`, затем `publishArticleDraft` в одной транзакционной операции сервиса. Это сохраняет замороженный контракт `POST /kb/drafts/{id}/approve` с ответом `200` и статусом `published`, но внутри сохраняются два явных перехода `pending_review → approved → published`, а не один переход загрузки документа. Тело содержит `actor`; повторное одобрение — `409 conflict`.
- [ ] Не создавать маршрутов `POST /kb/documents/{id}/approve` в составе среза и не импортировать/вызывать операции `kb_documents`. В интеграционном тесте создать синтетический `kb_documents` со `status='pending'`, выполнить `approve`/`publish` черновика и проверить, что статус документа остался `pending`, а документ не появился в поиске.
- [ ] **Зелёный тест:** HTTP-тест подтверждает `401` без менеджерской сессии, `201` при создании, `200 published` при одобрении, `409` при повторе, а также неизменность `kb_documents`.

### Шаг 7. Интеграционный тест среза

- [ ] Создать `tests/integration/04-article-draft-review.test.ts`: тестовая PostgreSQL-база готовится по образцу `tests/integration/13-import-knowledge-site.test.ts`; эмбеддинги детерминированные, внешняя сеть не используется.
- [ ] Кейс AC 1: менеджер создаёт черновик из сообщений диалога, видит `pending_review` и сохранённый провенанс.
- [ ] Кейс AC 2: уникальный текст ожидающего и затем отклонённого черновика не находится прямым поиском и не попадает в `answer.sources`.
- [ ] Кейс AC 3: после `approve` + `publish` тот же вопрос находится, возвращает содержимое статьи и ссылку на исходный диалог; агент цитирует статью.
- [ ] Кейс AC 4: модуль экспортирует `createArticleDraft`/`approveArticleDraft`/`publishArticleDraft`; документ в состоянии `pending` не меняется и не публикуется при операциях над статьёй.
- [ ] Кейс AC 5: до утверждения агент не ссылается на черновик и не строит на нём ответ; при отсутствии иного подтверждённого источника — эскалация.
- [ ] Кейс безопасности: запросы без менеджерской cookie и с клиентской cookie получают `401`; запись не создаётся; `tenant_id` не принимается из тела.
- [ ] **Зелёный тест:** `npm run test -- tests/integration/04-article-draft-review.test.ts` → команда проходит целиком.

### Шаг 8. Живой прогоны и свидетельства

- [ ] Живой прогон на синтетическом диалоге: менеджер создаёт черновик, поиск по уникальной фразе до утверждения не находит статью; в ответе агента нет ссылки на черновик.
- [ ] Живой прогон после менеджерского `approve`: тот же запрос находит опубликованную статью, возвращает содержимое и ссылку на исходный диалог в источниках/трассе, не вставляя URL в клиентский текст.
- [ ] Сохранить свидетельства без секретов и реальных персональных данных: вывод поиска до и после утверждения, идентификаторы синтетической статьи/диалога, HTTP-коды операций и код выхода `npm run test -- tests/integration/04-article-draft-review.test.ts`.

## На что обратить внимание при проверке

- `kb_articles` уже существует: нельзя создавать таблицу заново, дублировать `body_md` или считать `status='draft'` состоянием ожидания тикета. Для этого среза ожидание — отдельное `pending_review`.
- Провенанс обязателен: у опубликованной статьи должен быть прослеживаемый исходный диалог/материал. Поиск возвращает ссылку на этот источник, а не выдуманный URL.
- Ожидание и отклонение — не одно состояние: `pending_review` означает «менеджер ещё не решил», `rejected` — «решение принято, материал не используется». Оба запрещены в поиске.
- `approve` и `publish` — разные внутренние переходы, хотя замороженный HTTP-маршрут `/kb/drafts/{id}/approve` по контракту завершает процесс опубликованным статусом. Проверяющий должен убедиться, что оба перехода явны и что документный поток не затронут.
- Статья и документ остаются разными сущностями: у статьи `article_id` в `kb_chunks`, у документа — `document_id`; чанк принадлежит ровно одному владельцу согласно ограничению миграции 130.
- Фильтр поиска уже реализован в `src/modules/knowledge/search.ts` как `status='published'`; основной риск — не этот фильтр, а попытка в обход него проиндексировать или вернуть черновик агентом.
- Публикация должна быть атомарной со standpoint индексации: опубликованный статус без чанка даст «утверждённую, но ненайденную» статью, а чанк без статуса `published` — скрытый материал.
- Запрет автоматического обучения: до явного `approve` содержимое черновика не должно попадать ни в `answer.sources`, ни в контекст формирования ответа агента. Если тест подменяет только поиск, нужно отдельно проверить путь агента.
- Защита менеджера проверяется на HTTP-границе до бизнес-операции; наличие только клиентской cookie не должно создавать черновик.
