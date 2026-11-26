# Защита публичного стенда: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до Г3a волны 1 и отдельного «поехали» владельца.**

**Цель:** публичный стенд не должен позволить посторонним ботам выжечь лимит токенов: единый код доступа, привязанный к подписанной cookie, лимиты запросов и диалогов, жёсткий потолок бюджета модели.

**Архитектура:** Модули `access` и `limits` в каталоге среза. Счётчики хранятся в базе, а не в памяти процесса. Ядро агента не затрагивается: в волне 1 барьер проверяется собственными тестами, подключение к `POST /v1/chat` делает exec в волне 2 — это общая поверхность.

**Технологии:** Node.js 22 LTS, Next.js 16 App Router, TypeScript, PostgreSQL 16, `node-pg-migrate`, Vitest.

**Тикет:** `.scratch/support-agent/issues/11-public-demo-access.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`); контракт: `docs/api-contract.md` §11; данные: `docs/data-model.md`; план волны: `docs/plans/wave-1.md`.

## Команда проверки

`npm run test -- tests/integration/11-public-demo-access.test.ts`

Команда обязательна к приёмке среза. Юнит-тесты среза — обязательные шаги плана; интеграционный тест собирает их вместе и проверяет срез целиком.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Срез владеет каталогом `src/modules/access/**`, `src/modules/limits/**`, `src/app/access/**`, `src/app/api/access/**`.
- Общие поверхности не меняются: `docs/api-contract.md`, `docs/data-model.md`, роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`.
- Миграция этого среза — `4000_usage_counters.sql`. Номер закрепляет exec; агент числа не назначает.
- Токены и коды доступа — только переменные окружения/секретница; не в репозитории, журналах, доказательствах и описании.
- Пул тестовых процессов ограничен: `vitest --pool=forks --poolOptions.forks.maxForks=2`.

## На что обратить внимание при проверке

- Код доступа не попадает в cookie, в журналы и в ответы API.
- Смена кода в переменных окружения инвалидирует ранее выданные cookie.
- Перевыпуск cookie не обнуляет счётчики — иначе лимит обходится простым обновлением страницы.
- Перезапуск процесса не обнуляет суточный счётчик диалогов.
- Ошибка `429` или `402` провайдера не увеличивает счётчик расхода повторно.
- При исчерпании бюджета пользователь получает понятное сообщение, а не ошибку сервера.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/modules/access/index.ts` | Публичный API проверки кода и подписи сессии |
| `src/modules/access/session.ts` | Подпись cookie, проверка подписи и отпечатка кода |
| `src/modules/limits/index.ts` | Публичный API проверки лимитов и учёта расхода |
| `src/modules/limits/counters.ts` | Чтение и увеличение счётчиков в `usage_counters` |
| `src/app/access/page.tsx` | Страница ввода кода доступа |
| `src/app/api/access/route.ts` | Маршрут проверки кода и выдачи cookie |
| `db/migrations/4000_usage_counters.sql` | Таблица серверных счётчиков |
| `tests/access/access.test.ts` | Проверка кода доступа и cookie |
| `tests/limits/limits.test.ts` | Лимиты запросов, диалогов и бюджета |
| `tests/integration/11-public-demo-access.test.ts` | Интеграционный тест среза по команде тикета |

---

### Задача 1: Код доступа и подписанная cookie

**Файлы:**
- Создать: `src/modules/access/session.ts`, `src/modules/access/index.ts`, `src/app/access/page.tsx`, `src/app/api/access/route.ts`
- Тест: `tests/access/access.test.ts`

**Интерфейсы:**
- Использует: `getPool()`; переменные окружения `ACCESS_CODE`, `SESSION_SECRET`.
- Даёт: `verifyAccessCode(code: string): Promise<AccessSession | null>`, `signAccessSession(session: AccessSession): string`, `readAccessSession(cookieHeader: string | undefined): AccessSession | null`.

```ts
type AccessSession = {
  sessionId: string;
  codeDigest: string;
  expiresAt: number;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/access/access.test.ts`**

  Проверки: запрос без cookie `support_access` → `401`; неверный код → `401`, новая cookie не выдаётся; верный код → `200` и `Set-Cookie` с `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; код и его хеш отсутствуют в cookie и в журнале; смена кода в переменных окружения инвалидирует ранее выданную cookie; просроченная сессия не принимается.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm run test -- tests/access/access.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/modules/access/session.ts`**

  Сигнатуры из блока «Интерфейсы». Код доступа читается из `ACCESS_CODE`; сравнение — constant-time. Подпись cookie — HMAC-SHA256 с секретом `SESSION_SECRET`; в подпись входят идентификатор сессии, срок действия и отпечаток кода. Проверка отпечатка делает смену кода инвалидирующей. Время жизни сессии — константа модуля.

- [ ] **Шаг 4: Реализовать `src/modules/access/index.ts` и страницу `/access`**

  Экспортируются только `verifyAccessCode`, `signAccessSession`, `readAccessSession`. Страница: поле ввода кода, кнопка, понятное сообщение об отказе; код в разметку не попадает.

- [ ] **Шаг 5: Реализовать `src/app/api/access/route.ts`**

  Тело: `{ code: string }`. При верном коде — `200`, `Set-Cookie` и тело с идентификатором сессии и сроком действия. При неверном — `401 unauthorized`. Код не возвращается в ответе и не пишется в журнал.

- [ ] **Шаг 6: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/access/access.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 7: Зафиксировать изменения**

```bash
git add src/modules/access src/app/access src/app/api/access tests/access
git commit -m "feat: require access code on public demo stand"
```

---

### Задача 2: Лимиты запросов, диалогов и бюджета

**Файлы:**
- Создать: `src/modules/limits/counters.ts`, `src/modules/limits/index.ts`, `db/migrations/4000_usage_counters.sql`
- Тест: `tests/limits/limits.test.ts`

**Интерфейсы:**
- Использует: `getPool()`; переменные окружения `DAILY_DIALOG_LIMIT`, `REQUESTS_PER_MINUTE`, `MODEL_BUDGET_PER_DAY_RUB`, `MODEL_BUDGET_PER_HOUR_RUB`.
- Даёт: `checkRateLimit(ip: string): Promise<RateLimitDecision>`, `checkDailyDialogs(): Promise<RateLimitDecision>`, `checkModelBudget(): Promise<BudgetDecision>`, `recordModelSpend(costRub: number): Promise<void>`.

```ts
type RateLimitDecision = {
  allowed: boolean;
  reason: "ok" | "rate_limited" | "daily_limit";
  retryAfterSeconds: number | null;
  limit: number;
};

type BudgetDecision = {
  allowed: boolean;
  reason: "ok" | "budget_exhausted";
  spentHour: number;
  spentDay: number;
  limitHour: number;
  limitDay: number;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/limits/limits.test.ts`**

  Проверки: 10 запросов в минуту с одного IP проходят, 11-й отклоняется с `429` и `retryAfterSeconds`; 50 диалогов за сутки стартуют, 51-й не стартует; повторный ввод кода в новой вкладке не обнуляет счётчики; при часовом потолке 30 ₽ новые вызовы модели не выполняются, а результат — понятное сообщение «лимит демо исчерпан, попробуйте позже», без ошибки сервера; ошибка `429` или `402` провайдера не увеличивает счётчик расхода повторно; перезапуск процесса не обнуляет суточный счётчик.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm run test -- tests/limits/limits.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Создать миграцию `db/migrations/4000_usage_counters.sql`**

  Таблица `usage_counters` по `docs/data-model.md` §3.20: `scope`, `bucket_key`, `counter`, `spend_rub`, `window_start`. Уникальный индекс `(tenant_id, scope, bucket_key, window_start)`.

- [ ] **Шаг 4: Реализовать `src/modules/limits/counters.ts`**

  Счётчики в базе, не в памяти процесса. Окно запросов — одна минута по IP. Суточный счётчик диалогов — на стенд. Бюджет — по часу и суткам. Увеличение счётчика атомарно: `INSERT ... ON CONFLICT DO UPDATE SET counter = counter + 1`.

- [ ] **Шаг 5: Реализовать `src/modules/limits/index.ts`**

  Сигнатуры из блока «Интерфейсы». Значения лимитов читаются из переменных окружения; при незаданном значении действуют рабочие допущения из контракта: 10 запросов в минуту, 50 диалогов в сутки, 300 ₽ в сутки, 30 ₽ в час. `recordModelSpend` вызывается только после успешного вызова модели.

- [ ] **Шаг 6: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/limits/limits.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 7: Зафиксировать изменения**

```bash
git add src/modules/limits db/migrations/4000_usage_counters.sql tests/limits
git commit -m "feat: enforce rate, dialog and budget limits on demo stand"
```

## Самопроверка плана

- **Покрытие:** задача 1 — код доступа и cookie; задача 2 — лимиты и бюджет. Все шесть проверяемых ожиданий из контракта §11 имеют тест.
- **Шаги:** каждый шаг даёт один проверяемый артефакт; команды указаны с ожидаемым результатом.
- **Типы:** `verifyAccessCode`, `signAccessSession`, `checkRateLimit`, `checkDailyDialogs`, `checkModelBudget`, `recordModelSpend` согласованы с контрактом §0.3.
- **Границы:** срез не трогает ядро, роутер и корневой конфиг; подключение к `POST /v1/chat` делает exec в волне 2.
- **Пропорция:** план задаёт сигнатуры, файлы, тесты и команды; тела реализации оставлены исполнителю.

## Передача

1. Принятая спека и тикет среза защиты стенда;
2. Г3a — проверка supervisor с доказательствами;
3. отдельное «поехали» владельца;
4. выбор режима исполнения: субагенты или одна сессия.
