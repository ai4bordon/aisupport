# Загрузка, индексация и утверждение документов базы знаний: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до приёма на Г3a и отдельного «поехали» владельца.**

**Цель:** дать менеджеру отдельный поток загрузки документа базы знаний (PDF/DOCX/MD/TXT): система разбирает файл, нарезает на цитируемые чанки, индексирует их и показывает статус «на проверке», а в поиск материал попадает только после явного одобрения менеджера.

**Тикет:** `.scratch/support-agent/issues/03-document-upload-approval.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`), требование R6; ADR-0005 (документы и черновики статей — раздельные потоки одобрения).

**Контракт:** `docs/api-contract.md` §1 (единая HTTP-поверхность и публичные `index.ts` модулей), §2 (коды ошибок: `415 unsupported_media_type`, `413 payload_too_large`, `409 conflict`, `422 approval_required`), §3 (маршруты `POST /kb/documents`, `POST /kb/documents/{id}/approve`), §4 (веб-чат: `answer.sources` и запрет URL в клиентском тексте), §6 (контракт базы знаний: в выдачу только опубликованные источники).

**Данные:** `docs/data-model.md` §3.13 (`kb_documents`), §3.14 (`kb_chunks`), §3.22 (`kb_sources` — провенанс и снимки источников), §3.24 (`kb_source_snapshots`).

**Данные и реальное состояние (проверено в репозитории):**
- Таблица `kb_documents` уже создана миграцией `db/migrations/130_knowledge_core.sql`. Колонки: `id`, `tenant_id`, `filename`, `mime_type`, `size_bytes` (`CHECK > 0`), `storage_path`, `status` (`CHECK status IN ('pending','published','rejected')`), `chunks_count`, `created_at`, `approved_at`. Индекс `(tenant_id, status, created_at DESC)`. CHECK статуса разрешает ровно три состояния, поэтому состояние ошибки вводится расширением этого CHECK, а не новой таблицей.
- Таблица `kb_chunks` (`db/migrations/130_knowledge_core.sql`) требует ровно одного владельца: `document_id` либо `article_id` (`CHECK (num_nonnulls(document_id, article_id) = 1)`), уникальный индекс `(tenant_id, document_id, chunk_no)`. Колонка `embedding_model` добавлена миграцией `db/migrations/5200_chunk_embedding_model.sql` — при индексации модель вектора обязана записываться в чанк, иначе поиск отвергнет чанк как проиндексированный другой моделью.
- `kb_sources` и `kb_source_snapshots` созданы миграцией `db/migrations/2000_kb_sources.sql`: там уже есть `origin` (`CHECK origin IN ('docs_site','store_page')`), `source_url`, `snapshot_hash`, `provenance`, `crawled_at` и история снимков. Материал загрузки менеджера — не источник с сайта заказчика, поэтому он не пишется в `kb_sources`: ограничение `origin` его туда не пускает. Провенанс загрузки менеджера живёт в `kb_documents`.
- Модуль `src/modules/knowledge/` сейчас состоит из `index.ts` (публичный API: `search`, `initEmbeddingProvider`, `currentEmbeddingProvider`, `setEmbeddingProvider`) и `search.ts`. Фильтр опубликованных источников **уже реализован** в `src/modules/knowledge/search.ts`: обе ветви выдачи — векторная и полнотекстовая (`tsvector`) — требуют `a.status = 'published'` для статьи либо `d.status = 'published'` для документа. Параметров запроса, раскрывающих статус, у `search(query, tenantId, limit)` нет: арендатор и лимит — единственные входы, статус в allowlist жёстко зашит.
- `src/import/knowledge/` уже умеет: нарезать на цитируемые чанки (`chunk.ts` — `chunkSource(source)` и `sourceId(url)`, шапка чанка `Источник: <url> | <путь>`), считать векторы (`embedding.ts` — `createEmbeddingProvider`, `createDeterministicEmbeddingProvider`) и писать чанки (`importer.ts` — `importCrawledPages`, `importDocsSite`). `extract.ts` разбирает серверный HTML страниц сайта — для бинарных файлов PDF/DOCX он не подходит и не переносится в срез. Срез переиспользует нарезку, эмбеддинги и запись чанков и не создаёт второй реализации.
- `src/core/no-urls.ts` (`stripUrls`, `containsUrl`) уже вычищает URL из текста ответа; `src/core/run.ts` вызывает `stripUrls(generatedText)` и оставляет ссылки в `answer.sources`, трассе и кабинете менеджера. Этот механизм должен остаться единственным: URL не попадает в клиентский текст.
- Существующие роуты лежат в `src/app/api/`: `chat`, `agent/run`, `kb/search`, `docs/quote`, `access`, `health`, `max/status`. Роутера для `kb/documents` ещё нет.
- Барьер кабинета менеджера готов: `checkManagerAccess(request)` и `accessHttpStatus(decision)` в `src/modules/access/index.ts` (cookie `support_manager`, код из `MANAGER_CODE`).

**Технологии:** Node.js 22 LTS, TypeScript, PostgreSQL 16 + pgvector, Next.js 16 (Route Handlers, `multipart/form-data`), Vitest.

## Команда проверки

`npm run test -- tests/integration/03-document-upload-approval.test.ts`

Команда обязательна к приёмке среза: интеграционный тест собирает миграцию, загрузку, разбор, индекс, одобрение, поиск и агентный ответ в один сценарий; юнит-тесты среза — обязательные шаги плана.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Миграция среза — `db/migrations/2100_kb_document_upload.sql`. Номер закреплён exec: `2000` занят импортом БЗ с сайта, `2100` — следующий свободный в диапазоне 2xxx. Номер не пересекается с миграциями волны 2 диапазона 6xxx (`6000`, `6100`, `6300`, `6400`, `6500`, `6600`). При согласовании exec меняется только имя файла, содержимое сохраняется.
- Срез владеет: `db/migrations/2100_kb_document_upload.sql`, новым модулем `src/modules/document-upload/**`, маршрутами `src/app/api/kb/documents/**`, тестами `tests/integration/03-document-upload-approval.test.ts` и `tests/knowledge/document-upload.test.ts`.
- Общие поверхности не меняются без координации exec: `docs/api-contract.md`, `docs/data-model.md`, `src/core/run.ts` (кроме явно оговорённого ниже), `src/modules/knowledge/**` (кроме централизованного условия допуска — по AC 6), `src/modules/access/**`, `src/import/knowledge/**` (переиспользуется как есть), роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`.
- Операции и маршруты загрузки документов не смешиваются с черновиками статей (ADR-0005): срез 03 не создаёт и не меняет `kb_articles`, не вызывает модуль черновиков и не принимает `article_id`.
- Импорт материалов заказчика с сайта (`status='approved_by_customer'` в `kb_sources`) не проходит через поток тикета: материалы менеджера всегда ждут одобрения.
- Все менеджерские операции проходят через `checkManagerAccess`; клиентская cookie доступа стенда сама по себе не даёт права загружать и одобрять документы.
- Загрузка и импорт фида не запускаются одновременно — тяжёлые прогоны выполняет exec по одному.
- Пул тестовых процессов ограничен: `vitest --pool=forks --poolOptions.forks.maxForks=2`.
- Реальных персональных данных в тестовых материалах нет: используются синтетические документы.

## Связь критериев приёмки с шагами

| AC | Что проверяет | Шаги |
|---|---|---|
| 1 | Загрузка PDF/DOCX/MD/TXT извлекает текст, создаёт чанки, индексирует и показывает статус «на проверке» | 1, 2, 4, 7, 8 |
| 2 | Любое другое расширение отклоняется понятной ошибкой, доступный для поиска источник не создаётся | 3, 4, 7, 8 |
| 3 | До утверждения поиск не возвращает чанки документа, агент отвечает «нет в базе»/эскалирует | 2, 5, 6, 7, 8 |
| 4 | После утверждения тот же запрос получает чанки, цитату и источник в `answer.sources`; URL остаётся в источнике/трассе/кабинете и не уходит клиенту | 5, 6, 7, 8 |
| 5 | Ошибки разбора/индексации оставляют документ недоступным для поиска и видимым менеджеру в восстановимом состоянии ошибки | 1, 4, 6, 7, 8 |
| 6 | Фильтр опубликованных источников применяется централизованно в модуле `knowledge`; прямые параметры запроса не раскрывают ожидающий контент | 1, 6, 7, 8 |

## Шаги

### Шаг 1. Миграция: результат разбора, состояние ошибки и провенанс загрузки

- [ ] Создать `db/migrations/2100_kb_document_upload.sql` (Up):
  - расширить CHECK статуса `kb_documents` значением `error`: `ALTER TABLE kb_documents DROP CONSTRAINT kb_documents_status_check; ALTER TABLE kb_documents ADD CONSTRAINT kb_documents_status_check CHECK (status IN ('pending','published','rejected','error'));` — состояние `error` означает «разбор или индексация не удались, материал не доступен поиску и может быть повторён»;
  - добавить `parse_status text NOT NULL DEFAULT 'not_parsed' CHECK (parse_status IN ('not_parsed','parsed','failed'))` — результат разбора отдельно от статуса публикации;
  - добавить `parse_error text NULL` — короткое понятное сообщение об ошибке разбора/индексации (без стека и секретов);
  - добавить `provenance jsonb NOT NULL DEFAULT '{}'::jsonb` — провенанс загрузки: `uploaded_by`, `uploaded_at`, `source` (`manager_upload`), `original_filename`, `mime_detected`;
  - добавить `source_kind text NOT NULL DEFAULT 'manager_upload' CHECK (source_kind IN ('manager_upload'))` — провенанс происхождения: материал менеджера отличается от материала заказчика (`kb_sources.status='approved_by_customer'`);
  - добавить `source_url text NULL`, `snapshot_hash text NULL` — ссылка на материал в кабинете и хеш содержимого: по хешу повторная загрузка того же файла распознаётся, а не плодит дубли;
  - добавить `approved_by text NULL`, `rejected_reason text NULL` — кто и по какой причине решил судьбу документа;
  - добавить `parsed_at timestamptz NULL`, `failed_at timestamptz NULL`, `retry_count integer NOT NULL DEFAULT 0`, `last_attempt_at timestamptz NULL` — чтобы состояние ошибки было восстановимым: видно, что попытка была, когда и сколько раз;
  - добавить `extracted_chars integer NOT NULL DEFAULT 0` — объём извлечённого текста;
  - создать индекс `kb_documents_tenant_parse_status_created_at_idx ON kb_documents (tenant_id, parse_status, created_at DESC)` для выборки материалов в разборе и в ошибке.
- [ ] Существующие колонки `filename`, `mime_type`, `size_bytes`, `storage_path`, `status`, `chunks_count`, `created_at`, `approved_at` не переименовываются и не дублируются: они уже покрывают AC 1, а `status='pending'` — это и есть «на проверке».
- [ ] Провенанс пишется в `kb_documents`, а не в `kb_sources`: у материала менеджера нет URL источника, а `kb_sources.origin` ограничен значениями `docs_site`/`store_page` (`db/migrations/2000_kb_sources.sql`). Поле `storage_path` хранит путь к сохранённому файлу; ссылка на источник для цитирования — имя файла документа и, при наличии, ссылка менеджера, которая попадает в шапку чанка и в `location`.
- [ ] Зафиксировать семантику состояний в комментариях миграции: `pending` — разобран и проиндексирован, ждёт одобрения менеджера; `published` — одобрен и доступен поиску; `rejected` — отклонён менеджером, никогда не индексируется; `error` — разбор или индексация не удались, материал недоступен поиску и доступен для повторной попытки.
- [ ] Применить: `npm run db:migrate:up` → в выводе `применено: 2100_kb_document_upload.sql`; проверить `\d kb_documents` — новые поля и расширенный CHECK на месте.
- [ ] Проверить откат: `npm run db:migrate:down` → добавленные поля, индекс и значение `error` в CHECK исчезают, существующие документы и их статусы не теряются; затем применить миграцию снова.

### Шаг 2. Падающий тест: загрузка создаёт документ в статусе pending, чанки проиндексированы, но поиск их не возвращает

- [ ] **Падающий тест** `tests/knowledge/document-upload.test.ts` (создаваемый файл): подготовить свой арендатор (`resetTenant` из `tests/db/helpers.ts`) и детерминированный провайдер эмбеддингов (`setEmbeddingProvider` из `src/modules/knowledge` либо `createDeterministicEmbeddingProvider` из `src/import/knowledge/embedding.ts`).
- [ ] **Падающий тест** на приём форматов: для каждого из PDF, DOCX, MD, TXT загрузка даёт запись в `kb_documents` со `status='pending'`, `parse_status='parsed'`, непустым `chunks_count` и `extracted_chars > 0`.
- [ ] **Падающий тест** на индексацию: у документа есть чанки в `kb_chunks` с `document_id` этой записи, непустым `embedding`, `search_vector` и `embedding_model`, совпадающим с моделью текущего провайдера.
- [ ] **Падающий тест** на невидимость: публичный `search` из `src/modules/knowledge` по уникальной фразе из загруженного документа не возвращает ни одного чанка этого документа. Проверяются обе ветви выдачи — векторная и полнотекстовая, — потому что они в `src/modules/knowledge/search.ts` независимы.
- [ ] **Падающий тест** на изоляцию: документ другого арендатора с тем же текстом не появляется в выдаче текущего.
- [ ] **Зелёный тест:** после реализации шага 4 этот набор проходит; до реализации — падение из-за отсутствующего модуля загрузки.

### Шаг 3. Падающий тест: неподдерживаемое расширение отклоняется, источник не создаётся

- [ ] **Падающий тест** `tests/knowledge/document-upload.test.ts`: загрузка файла с расширением `.exe`, `.zip`, `.doc` и без расширения отклоняется доменной ошибкой с кодом `unsupported_media_type` и понятным текстом, перечисляющим поддерживаемые форматы (`PDF, DOCX, Markdown, TXT`).
- [ ] **Падающий тест** на отсутствие следа: после отклонения в `kb_documents` нет ни одной новой записи, в `kb_chunks` нет новых чанков, на диске не осталось сохранённого файла. Проверка идёт по всем трём поверхностям — «источник не создаётся» означает отсутствие записи, а не только запись со статусом `rejected`.
- [ ] **Падающий тест** на порядок проверки: отклонение происходит **до** попытки разбора: файл с неподдерживаемым расширением, но с корректным содержимым PDF не должен порождать ни текста, ни чанков. Тест подменяет разбор счётчиком вызовов и проверяет, что разбор не вызывался.
- [ ] **Зелёный тест:** после реализации шага 4 отклонение даёт `415 unsupported_media_type` по HTTP-контракту и не оставляет следов в базе и на диске.

### Шаг 4. Реализация загрузки и разбора с переиспользованием существующих модулей

- [ ] Создать `src/modules/document-upload/types.ts` (создаваемый файл): `SupportedDocumentFormat = "pdf" | "docx" | "md" | "txt"`, `DocumentStatus = "pending" | "published" | "rejected" | "error"`, `DocumentUploadInput { tenantId, filename, mimeType, bytes, uploadedBy }`, `DocumentRecord { id, filename, mimeType, sizeBytes, status, parseStatus, parseError, chunksCount, extractedChars, sourceKind, sourceUrl, snapshotHash, approvedBy, rejectedReason, retryCount, createdAt }`, `DocumentErrorCode = "unsupported_media_type" | "payload_too_large" | "parse_failed" | "index_failed" | "not_found" | "conflict"`.
- [ ] Создать `src/modules/document-upload/errors.ts` (создаваемый файл): `class KnowledgeDocumentError extends Error` с полями `code`, `field` — по образцу `DocumentError` из `src/modules/documents/render.ts`; коды совпадают с таблицей ошибок `docs/api-contract.md` §2 (`unsupported_media_type` → 415, `payload_too_large` → 413, `not_found` → 404, `conflict` → 409).
- [ ] Создать `src/modules/document-upload/parse.ts` (создаваемый файл) — разбор загруженного файла:
  - определение формата по расширению **и** по сигнатуре содержимого (PDF — `%PDF-`, DOCX — ZIP-контейнер с `word/document.xml`, MD/TXT — текст). Расширение и сигнатура должны совпадать; при расхождении — `unsupported_media_type`;
  - PDF: собственная минимальная реализация в `src/modules/document-upload/parse.ts` — разбор потоков страниц и `ToUnicode`-карт, без внешней зависимости. Тестовый помощник `tests/documents/pdf-inspect.ts` в production-код не переносится: он живёт в тестах среза документов и остаётся там;
  - DOCX: чтение `word/document.xml` из ZIP-контейнера средствами `node:zlib` (`inflateRawSync`) и разбор XML без внешней библиотеки; из текста берутся абзацы;
  - MD/TXT: чтение как UTF-8, нормализация переводов строк;
  - всё это — **разбор загруженного файла**, а не HTML: существующий `src/import/knowledge/extract.ts` работает с серверным HTML и для бинарных форматов не подходит. Переиспользованию подлежат нарезка, эмбеддинги и запись чанков, а не HTML-парсер.
- [ ] Создать `src/modules/document-upload/chunking.ts` (создаваемый файл): адаптация результата разбора к существующему `chunkSource` из `src/import/knowledge/chunk.ts` — формируется `SourceContent { url, title, sectionPath, text, crawledAt }`, где `url` — безопасная ссылка на загруженный документ (имя файла в кабинете менеджера, не клиентский URL), а `crawledAt` — время загрузки. Нарезка выполняется существующим `chunkSource`, вторая реализация нарезки не создаётся. Шапка чанка `Источник: …` берётся из того же кода, что и у импорта с сайта, — цитата строится одинаково.
- [ ] Создать `src/modules/document-upload/indexer.ts` (создаваемый файл): индексация чанков документа через провайдер эмбеддингов из `src/import/knowledge/embedding.ts` (`createEmbeddingProvider` при наличии `OPENCODE_API_KEY`, иначе `createDeterministicEmbeddingProvider`) — модель вектора записывается в `embedding_model` чанка, иначе поиск отвергнет чанк как проиндексированный другой моделью (`db/migrations/5200_chunk_embedding_model.sql`). Запись идёт в `kb_chunks` с `document_id`, `chunk_no`, `text`, `search_vector` (`to_tsvector('russian', …)`), `embedding`, `embedding_model`; чанки документа удаляются перед перезаписью, чтобы повторная попытка не плодила дубли.
- [ ] Создать `src/modules/document-upload/service.ts` (создаваемый файл): операции `uploadDocument(input): Promise<DocumentRecord>`, `retryDocumentParse(tenantId, id): Promise<DocumentRecord>`, `approveDocument(tenantId, id, actor): Promise<DocumentRecord>`, `rejectDocument(tenantId, id, actor, reason): Promise<DocumentRecord>`, `getDocument(tenantId, id): Promise<DocumentRecord | null>`, `listDocuments(tenantId, filter): Promise<DocumentRecord[]>`.
  - `uploadDocument` определяет формат, при отказе бросает `KnowledgeDocumentError("unsupported_media_type")` **до** создания записи; записывает файл в каталог хранения (`process.env.KB_DOCUMENTS_DIR` либо `join(tmpdir(), "aisupport-kb-documents")` — по образцу `documentsDirectory()` в `src/modules/documents/render.ts`), создаёт запись `kb_documents` со `status='pending'`, `parse_status='not_parsed'`, `source_kind='manager_upload'`, `snapshot_hash` от содержимого, `storage_path` и `provenance`-набором (`uploaded_by`, `uploaded_at`, `original_filename`, `mime_detected` в `jsonb`-колонке `provenance`);
  - разбор и индексация выполняются в одной транзакции с обновлением записи: успех → `parse_status='parsed'`, `chunks_count`, `extracted_chars`, `parsed_at`, `status` остаётся `pending`; провал → откат записи чанков, `parse_status='failed'`, `parse_error` с понятным текстом, `status='error'`, `failed_at`, `last_attempt_at`, `retry_count + 1`. Документ в состоянии `error` остаётся видимым менеджеру и недоступен поиску;
  - `approveDocument` допускает только `pending → published`, проставляет `approved_at`, `approved_by`; повторное одобрение — `KnowledgeDocumentError("conflict")`;
  - `rejectDocument` допускает только `pending → rejected` и `error → rejected` (менеджер снял материал с проверки); переход из `published` запрещён;
  - `retryDocumentParse` повторяет разбор и индексацию документа в состоянии `error`, не создавая новой записи документа: состояние ошибки восстановимо, а не «потеряно»;
  - ни одна операция не принимает `tenant_id` из тела HTTP-запроса — арендатор определяется сервером через `getTenantId()` из `src/db/tenant.ts`.
- [ ] Создать `src/modules/document-upload/index.ts` (создаваемый файл) — единственная публичная точка модуля: экспортируются операции, типы и `KnowledgeDocumentError`; внутренние `parse.ts`, `chunking.ts`, `indexer.ts`, `repository.ts` наружу не выходят, доступ к `pg` остаётся внутри модуля.
- [ ] Создать `src/app/api/kb/documents/route.ts` (создаваемый файл): `POST` принимает `multipart/form-data`, поле `file` (по `docs/api-contract.md` §6). Порядок: барьер `checkManagerAccess({ cookieHeader })` → `401 unauthorized` при отказе; чтение файла и проверка размера → `413 payload_too_large`; определение формата → `415 unsupported_media_type` с перечислением поддерживаемых форматов; `uploadDocument` → ответ `202` с `{ id, status: "pending", filename, mime_type, chunks_count }`. `tenant_id` берётся сервером (`getTenantId()`), из тела не принимается. Имена в JSON — `snake_case` (провенанс контракта §2).
- [ ] Создать `src/app/api/kb/documents/[id]/approve/route.ts` (создаваемый файл): `POST` за барьером `checkManagerAccess` вызывает `approveDocument` с `actor` из тела; ответ `200` — сущность со статусом `published`; повторное одобрение — `409 conflict`; чужой или несуществующий документ — `404 not_found`, существование чужой записи не раскрывается.
- [ ] **Зелёный тест:** `npx vitest run tests/knowledge/document-upload.test.ts` — шаги 2 и 3 проходят: четыре поддерживаемых формата создают `pending` с проиндексированными чанками, поиск их не возвращает; неподдерживаемый формат отклонён без следа.

### Шаг 5. Падающий тест: после одобрения тот же запрос получает чанки, цитату и источник, URL в клиентском тексте нет

- [ ] **Падающий тест** `tests/knowledge/document-upload.test.ts`: загрузить документ, вызвать `approveDocument`, затем повторить тот же поисковый запрос — публичный `search` из `src/modules/knowledge` возвращает чанки с `kind="kb_document"`, `articleId` равным id документа, непустым `title` (имя файла), непустым `text` и `location`, указывающим на источник.
- [ ] **Падающий тест** на цитату: найденный текст чанка содержит цитируемый фрагмент документа, а `location` однозначно указывает на загруженный файл — без подмены на выдуманный внешний URL.
- [ ] **Падающий тест** на агентный ответ: `runAgent` из `src/core/run.ts` (модель подменяется на границе, как в `tests/core/run.test.ts`) на вопрос по тексту документа возвращает `outcome="respond"`, `answer.sources` содержит источник с `kind="kb_document"` и id документа, а `answer.text` **не содержит URL** — проверяется и `containsUrl` из `src/core/no-urls.ts`, и отсутствие ссылки на документ в клиентском тексте.
- [ ] **Падающий тест** на трассу и источники: в шагах трассы (`agent_steps`) узел `retrieve` содержит `source_ids` с id документа, а запись ответа (`messages.sources` либо `escalations.sources`) содержит тот же источник — то есть источник виден в трассе и кабинете менеджера.
- [ ] **Падающий тест** на «до одобрения»: тот же вопрос до `approveDocument` даёт `outcome="escalate"` с причиной `no_confirmed_source` либо честный ответ «нет в базе» (режим `ESCALATION_MODE=off`, `noSourceAnswer()` из `src/core/escalation-mode.ts`), и в `answer.sources` нет документа. Это прямое исполнение AC 3.
- [ ] **Зелёный тест:** после реализации шагов 4 и 6 этот набор проходит.

### Шаг 6. Централизованный фильтр опубликованных источников и восстановимое состояние ошибки

- [ ] **Падающий тест** `tests/knowledge/document-upload.test.ts`: оба пути выдачи используют один allowlist. Проверка идёт по коду и по поведению: в `src/modules/knowledge/search.ts` условие допуска вынесено в одну константу/фрагмент SQL, используемый и векторной, и полнотекстовой веткой; тест подставляет документ в каждом из состояний `pending`, `error`, `rejected`, `published` и проверяет, что выдача содержит чанк только при `published`.
- [ ] **Падающий тест** на невозможность обхода параметрами: публичный `search(query, tenantId, limit)` не имеет параметров, раскрывающих статус или обходящих allowlist; попытка передать в запросе `GET /kb/search` параметров вида `status`, `include_pending`, `document_id` не меняет выдачу — маршрут `src/app/api/kb/search/route.ts` (существующий файл, общая поверхность) их просто не читает, а лимит ограничен 1..20. Тест фиксирует, что в `src/app/api/kb/search/route.ts` новых параметров не появляется.
- [ ] **Падающий тест** на состояние ошибки: при сбое разбора (испорченный файл) или сбое индексации (подставной провайдер эмбеддингов, бросающий ошибку) документ получает `status='error'`, `parse_status='failed'`, непустой `parse_error`, остаётся видимым в списке менеджера и **не** появляется в поиске; `retry_count` увеличивается, `last_attempt_at` обновляется.
- [ ] **Падающий тест** на восстановимость: после `retryDocumentParse` на исправном файле документ переходит в `status='pending'`, `parse_status='parsed'`, чанки перезаписаны, и после одобрения он находится поиском. До повторного успеха материал остаётся невидимым для поиска.
- [ ] Усилить `src/modules/knowledge/search.ts` (общая поверхность, изменение согласовывается с exec): вынести условие допуска в одну константу, например `PUBLISHED_SOURCE_PREDICATE`, и подставить её в оба запроса — векторный и текстовый. Смысл не меняется: `kb_articles.status='published'` либо `kb_documents.status='published'`. Расширять allowlist нельзя: `pending`, `error`, `rejected`, `draft` не попадают в выдачу никогда.
- [ ] При ошибке разбора/индексации `src/modules/knowledge` не меняется: поиск не должен падать из-за сломанного документа — он просто не видит его, потому что документ не `published`.
- [ ] **Зелёный тест:** `npx vitest run tests/knowledge/document-upload.test.ts tests/knowledge/search.test.ts` — фильтр централизован, ожидающий и сломанный материал не выдаётся, состояние ошибки восстановимо повторной попыткой.

### Шаг 7. Интеграционный тест среза

- [ ] Создать `tests/integration/03-document-upload-approval.test.ts` (создаваемый файл): тестовая PostgreSQL-база готовится по образцу `tests/integration/13-import-knowledge-site.test.ts`; эмбеддинги детерминированные, внешняя сеть не используется, секретов в тесте нет.
- [ ] Кейс AC 1: менеджер загружает PDF, DOCX, MD и TXT; для каждого — запись `kb_documents` в состоянии `pending`, `chunks_count > 0`, чанки в `kb_chunks` с вектором и `embedding_model`; HTTP-ответ `202` содержит `id`, `status: "pending"`, `filename`, `mime_type`, `chunks_count` (по `docs/api-contract.md` §6).
- [ ] Кейс AC 2: загрузка `.exe`/`.zip` даёт `415 unsupported_media_type` с понятным текстом; в `kb_documents` и `kb_chunks` нет новых записей.
- [ ] Кейс AC 3: до одобрения `GET /kb/search` и `runAgent` не находят документ; агент отвечает «нет в базе» либо эскалирует с `no_confirmed_source`.
- [ ] Кейс AC 4: после `POST /kb/documents/{id}/approve` тот же запрос находит чанк, `answer.sources` содержит `kind="kb_document"` с id документа, `answer.text` не содержит URL (проверка `containsUrl`), источник виден в трассе и в записи ответа.
- [ ] Кейс AC 5: сбой разбора оставляет документ в состоянии `error` с непустым `parse_error`, он не находится поиском и виден менеджеру; повторная попытка на исправном файле возвращает его в `pending`.
- [ ] Кейс AC 6: документ в каждом непубличном состоянии не попадает в выдачу ни одной из двух ветвей поиска; прямые параметры запроса (`status`, `include_pending`, `document_id`) результата не меняют.
- [ ] Кейс безопасности: `POST /kb/documents` и `POST /kb/documents/{id}/approve` без менеджерской cookie дают `401 unauthorized`; `tenant_id` не принимается из тела; чужой документ другого арендатора не одобряется и не находится (`404`).
- [ ] **Зелёный тест:** `npm run test -- tests/integration/03-document-upload-approval.test.ts` → команда проходит целиком.

### Шаг 8. Живые прогоны и свидетельства

- [ ] Живой прогон загрузки: менеджер входит в кабинет по коду менеджера (`MANAGER_CODE`), загружает **синтетический** документ (никаких реальных данных клиентов) — ответ `202`, в списке документов видно статус «на проверке» и число чанков.
- [ ] Живой прогон до одобрения: задать вопрос по содержимому загруженного документа в веб-чате (`http://127.0.0.1:3000/widget`) — в ответе нет ссылки на документ, агент отвечает «нет в базе» либо эскалирует менеджеру; в `answer.sources` документа нет.
- [ ] Живой прогон одобрения: одобрить документ в кабинете, повторить тот же вопрос — ответ содержит цитату, в `answer.sources` виден источник, в клиентском тексте **нет URL**, а в трассе и в источниках записи источник присутствует.
- [ ] Живой прогон неподдерживаемого формата: загрузить файл с другим расширением — понятное сообщение об отклонении, документ в списке не появляется.
- [ ] Сохранить свидетельства без секретов и реальных персональных данных: вывод команды проверки с кодом возврата, HTTP-коды операций, идентификаторы синтетического документа и выдержки из выдачи до и после одобрения.

## На что обратить внимание при проверке

- `kb_documents` уже существует: таблицу не создают заново, `status`, `mime_type`, `storage_path`, `size_bytes` и `chunks_count` не дублируют и не переименовывают. Миграция среза только **расширяет** сущность результатом разбора, состоянием ошибки и провенансом.
- «На проверке» — это `status='pending'`, а не отдельное состояние: так уже зафиксировано в `db/migrations/130_knowledge_core.sql` и в `docs/data-model.md` §3.13. Проверяющий не должен требовать нового имени состояния.
- Индексация происходит **до** одобрения: чанки у документа `pending` существуют и лежат в `kb_chunks`, но недоступны поиску. Проверка «чанков нет» была бы неверной — правильная проверка «чанки есть, выдачи нет».
- Фильтр опубликованных источников уже был в `src/modules/knowledge/search.ts` до среза. AC 6 требует не новой логики, а централизации: одно условие допуска на обе ветви выдачи (векторную и полнотекстовую) и отсутствие параметров, раскрывающих статус. Проверяющий должен убедиться, что allowlist не расширен и что `pending`/`error`/`rejected`/`draft` не проходят ни по одной ветви.
- Разбор загруженного файла и разбор HTML заказчика — разные задачи. Существующий `src/import/knowledge/extract.ts` работает с серверным HTML и не переиспользуется для PDF/DOCX; переиспользуются нарезка (`chunk.ts`), эмбеддинги (`embedding.ts`) и запись чанков — дублировать их нельзя.
- URL в клиентском тексте запрещён не новым правилом среза, а уже существующим `stripUrls` из `src/core/no-urls.ts`, который вызывается в `src/core/run.ts`. Проверяющий убеждается, что путь ответа не обходит `stripUrls` и что ссылка осталась в `answer.sources`, трассе и кабинете.
- Ошибка разбора не должна «съедать» материал: документ остаётся в базе в состоянии `error` с понятным `parse_error`, доступен менеджеру и может быть разобран повторно без создания новой записи.
- Публикация и индекс должны быть согласованы: `published`-документ без чанков даст «одобрённый, но ненайденный» материал, а чанки без `published` — скрытый материал. Одобрение переводит статус уже проиндексированного документа, а не индексирует его заново.
- `embedding_model` в чанке обязателен: модель вектора запроса и модель индекса должны совпадать, иначе поиск отвергнет чанк как проиндексированный другой моделью (`db/migrations/5200_chunk_embedding_model.sql`).
- Материалы заказчика, импортированные с сайта, идут через `kb_sources` со `status='approved_by_customer'` и через поток тикета 03 не проходят: поток тикета 03 — только материалы, загруженные менеджером (`source_kind='manager_upload'`), и они всегда ждут одобрения.
- Документ и черновик статьи — разные сущности с разными маршрутами и переходами состояний (ADR-0005). Срез 03 не трогает `kb_articles` и не вызывает модуль черновиков; обратное — тоже: одобрение статьи не публикует загруженные файлы.
- Чужие арендаторы: документ, загруженный одним `tenant_id`, не находится и не одобряется из другого — проверяется и на уровне SQL, и на уровне HTTP.
