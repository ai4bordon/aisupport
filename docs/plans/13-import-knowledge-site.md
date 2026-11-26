# Импорт базы знаний с сайта заказчика: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до Г3a волны 1 и отдельного «поехали» владельца.**

**Цель:** получить 200–500 статей с сайта `docs.softline.com` и страницы `store.softline.ru/delivery_info/` с провенансом, нарезанными на цитируемые чанки, готовыми к поиску без ручного одобрения.

**Архитектура:** Обход в ширину от восьми корневых разделов с ограничением глубины. Сырой HTML кладётся в кэш на диске, в базу попадает только извлечённый текст. Источник получает статус `approved_by_customer` и провенанс, потому что это материалы, которые заказчик сам дал как базу знаний.

**Технологии:** Node.js 22 LTS, TypeScript, PostgreSQL 16 + pgvector, `node-pg-migrate`, Vitest.

**Тикет:** `.scratch/support-agent/issues/13-import-knowledge-site.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`); контракт: `docs/api-contract.md` §8; данные: `docs/data-model.md` §3.14, §3.22; план волны: `docs/plans/wave-1.md`.

## Команда проверки

`npm run test -- tests/integration/13-import-knowledge-site.test.ts`

Команда обязательна к приёмке среза. Юнит-тесты среза — обязательные шаги плана; интеграционный тест собирает их вместе и проверяет срез целиком.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Срез владеет каталогом `src/import/knowledge/**`, `scripts/import-docs.ts`.
- Общие поверхности не меняются: `docs/api-contract.md`, `docs/data-model.md`, роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`.
- Миграция этого среза — `2000_kb_sources.sql`. Номера закрепляет exec.
- Обход сайта: один запрос в секунду, глубина до трёх, никаких параллельных залпов. При `429` или `5xx` обход останавливается, работа продолжается на закэшированном материале.
- Импорт фида и обход сайта не запускаются одновременно — тяжёлые прогоны выполняет exec по одному.
- Пул тестовых процессов ограничен: `vitest --pool=forks --poolOptions.forks.maxForks=2`.

## На что обратить внимание при проверке

- Повторный запуск обхода берёт кэш и не обращается к сайту.
- При `429` обход останавливается с `stoppedReason=rate_limited`, а уже собранные страницы импортируются.
- В каждом чанке есть URL источника — без него цитата невозможна.
- Импортированный источник не ждёт ручного одобрения: `status=approved_by_customer`, провенанс непустой.
- Границы чанков не разрывают предложение без необходимости.
- Поиск возвращает чанк с URL источника; запись трассы хранит идентификатор источника и дату обхода.
- Файл, загруженный менеджером, и черновик статьи по-прежнему требуют одобрения — импорт заказчика этого не отменяет.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/import/knowledge/crawl.ts` | Обход в ширину, кэш, остановка при `429`/`5xx` |
| `src/import/knowledge/extract.ts` | Извлечение заголовка, пути разделов и текста |
| `src/import/knowledge/chunk.ts` | Нарезка на чанки по 800–1200 знаков |
| `src/import/knowledge/importer.ts` | Запись источника и чанков, провенанс |
| `src/import/knowledge/index.ts` | Публичный API импорта |
| `scripts/import-docs.ts` | Запуск обхода и импорта |
| `db/migrations/2000_kb_sources.sql` | Таблица `kb_sources` |
| `tests/knowledge/import.test.ts` | Обход, кэш, остановка, провенанс |
| `tests/knowledge/chunk.test.ts` | Нарезка на чанки |

---

### Задача 1: Обход сайта и извлечение материала

**Файлы:**
- Создать: `src/import/knowledge/crawl.ts`, `src/import/knowledge/extract.ts`, `src/import/knowledge/index.ts`
- Тест: `tests/knowledge/import.test.ts`

**Интерфейсы:**
- Использует: только HTTP-клиент и файловую систему; база не требуется.
- Даёт: `crawlSite(options: CrawlOptions): Promise<CrawlReport>`, `extractPage(html: string, url: string): ExtractedPage`.

```ts
type CrawlOptions = {
  roots: string[];
  maxDepth: number;
  delayMs: number;
  userAgent: string;
  cacheDir: string;
  timeBudgetMs: number;
};

type CrawlReport = {
  visited: number;
  cached: number;
  failed: number;
  stoppedReason: "completed" | "rate_limited" | "server_error" | "time_budget";
};

type ExtractedPage = {
  url: string;
  title: string;
  sectionPath: string;
  text: string;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/knowledge/import.test.ts`**

  Фикстура: локальные HTML-страницы, подставленные вместо сайта. Проверки: извлекаются заголовок, путь разделов и основной текст; URL дедуплицируется; глубина ограничена заданной; при `429` обход останавливается с `stoppedReason=rate_limited`, и уже собранные страницы доступны; повторный запуск берёт кэш и не делает запросов к сайту; между запросами проходит не меньше заданной паузы.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm run test -- tests/knowledge/import.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/import/knowledge/crawl.ts`**

  Обход в ширину от заданных корневых разделов, глубина до заданной. Дедупликация по URL. Между запросами — пауза не меньше заданной. `User-Agent` с указанием контакта. При `429` или `5xx` обход останавливается, причина фиксируется в отчёте. Таймбокс обхода соблюдается. Сырой HTML сохраняется в кэш по URL; повторный запуск читает кэш.

- [ ] **Шаг 4: Реализовать `src/import/knowledge/extract.ts`**

  Из страницы извлекаются заголовок, путь разделов, основной текст, URL и дата обхода. Разметка и служебные блоки отбрасываются; в результат попадает только текст.

- [ ] **Шаг 5: Реализовать публичный `src/import/knowledge/index.ts`**

  Экспортируются `crawlSite` и `extractPage`. Внутренние файлы не импортируются вне модуля.

- [ ] **Шаг 6: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/knowledge/import.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 7: Зафиксировать изменения**

```bash
git add src/import/knowledge/crawl.ts src/import/knowledge/extract.ts src/import/knowledge/index.ts tests/knowledge/import.test.ts
git commit -m "feat: crawl customer knowledge site with cache and polite rate"
```

---

### Задача 2: Нарезка на чанки и импорт с провенансом

**Файлы:**
- Создать: `src/import/knowledge/chunk.ts`, `src/import/knowledge/importer.ts`, `scripts/import-docs.ts`, `db/migrations/2000_kb_sources.sql`
- Тест: `tests/knowledge/chunk.test.ts`

**Интерфейсы:**
- Использует: `getPool()`, порт эмбеддингов из контракта.
- Даёт: `chunkSource(source: SourceContent): Chunk[]`, `importDocsSite(options: CrawlOptions): Promise<ImportReport>`.

```ts
type SourceContent = {
  url: string;
  title: string;
  sectionPath: string;
  text: string;
  crawledAt: string;
};

type Chunk = {
  articleId: string;
  chunkNo: number;
  totalChunks: number;
  title: string;
  sectionPath: string;
  sourceUrl: string;
  text: string;
};

type ImportReport = {
  sources: number;
  chunks: number;
  failed: number;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/knowledge/chunk.test.ts`**

  Проверки: текст делится на чанки по 800–1200 знаков; в каждом чанке сохранены заголовок, путь разделов и URL источника; короткий текст даёт один чанк; границы не разрывают предложение без необходимости; `chunkNo` и `totalChunks` согласованы.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm test -- tests/knowledge/chunk.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Создать миграцию `db/migrations/2000_kb_sources.sql`**

  Таблица `kb_sources` по `docs/data-model.md` §3.22: `origin`, `source_url`, `title`, `section_path`, `content_text`, `raw_html_path`, `crawled_at`, `status`, `provenance`. Уникальный индекс `(tenant_id, source_url)`.

- [ ] **Шаг 4: Реализовать `src/import/knowledge/chunk.ts`**

  Размер чанка 800–1200 знаков, цель — 1000. Границы ставятся по границам предложений, если предложение помещается. Чанк несёт заголовок, путь разделов, URL источника, номер и общее число чанков источника.

- [ ] **Шаг 5: Реализовать `src/import/knowledge/importer.ts`**

  Источник записывается со `status=approved_by_customer` и непустым провенансом вида `docs.softline.com, обход 26.11.2026`. Чанки записываются с вектором и `page_no` из пути разделов. Страница `store.softline.ru/delivery_info/` импортируется как источник с `origin=store_page` и провенансом `store_page`.

  Запись трассы хранит идентификатор источника и дату обхода: по трассе видно, каким источником и когда он получен. Импорт заказчика не отменяет одобрение для файлов менеджера и черновиков статей.

- [ ] **Шаг 6: Реализовать `scripts/import-docs.ts`**

  Запускает обход, сохраняет сырой HTML в кэш, извлекает текст, нарезает на чанки, считает векторы и записывает источники. Печатает отчёт и завершается с ненулевым кодом при наличии ошибок.

- [ ] **Шаг 7: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/knowledge/import.test.ts tests/knowledge/chunk.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 8: Выполнить обход с таймбоксом**

  Команда: `npm run import:docs -- --roots id,lk,subscriptions,vendors,checkout,merchant-portal,payment,allsoft --max-depth 3 --delay-ms 1000 --time-budget-ms 900000`
  Ожидание: отчёт содержит число просмотренных и импортированных страниц; при `rate_limited` обход останавливается, импортированное сохраняется.

  Прогон выполняет exec, не агент: обход не должен идти одновременно с импортом фида.

- [ ] **Шаг 9: Зафиксировать изменения**

```bash
git add src/import/knowledge/chunk.ts src/import/knowledge/importer.ts scripts/import-docs.ts db/migrations/2000_kb_sources.sql tests/knowledge/chunk.test.ts
git commit -m "feat: chunk and import knowledge sources with provenance"
```

## Самопроверка плана

- **Покрытие:** задача 1 — обход, кэш, извлечение; задача 2 — нарезка, импорт, провенанс. Все требования контракта §8 имеют тест.
- **Шаги:** каждый шаг даёт один проверяемый артефакт; команды указаны с ожидаемым результатом.
- **Типы:** `crawlSite`, `extractPage`, `chunkSource`, `importDocsSite` согласованы с контрактом §0.3 и §8.
- **Границы:** срез не трогает ядро, роутер и корневой конфиг; код другого среза не импортируется.
- **Пропорция:** план задаёт сигнатуры, файлы, тесты и команды; тела реализации оставлены исполнителю.

## Передача

1. Принятая спека и тикет среза импорта базы знаний;
2. Г3a — проверка supervisor с доказательствами;
3. отдельное «поехали» владельца;
4. выбор режима исполнения: субагенты или одна сессия.
