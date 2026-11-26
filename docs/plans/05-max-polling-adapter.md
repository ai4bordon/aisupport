# MAX-адаптер: план реализации

> **Для исполнителей:** обязательный навык: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans — выполнять план по задачам. Шаги отмечаются флажком (`- [ ]`).
>
> **Статус: ЧЕРНОВИК — не исполнять до Г3a волны 1 и отдельного «поехали» владельца.**

**Цель:** живой обмен через MAX-бота `@se15151074_bot` с тем же ядром агента, что и веб-чат: входящее сообщение доходит до ядра, ответ уходит в MAX, в режиме тени в MAX не отправляется ничего.

**Архитектура:** Адаптер канала `channels/max` реализует приём событий через Long Polling и отправку через `POST /messages`. Ядро в волне 1 не затрагивается: адаптер работает через замороженный контракт нормализованного сообщения и результата. Официальный SDK `@maxhub/max-bot-api` (MIT) используется как зависимость; при фактическом использовании версия и лицензия идут в перечень компонентов сдачи.

**Технологии:** Node.js 22 LTS, TypeScript, PostgreSQL 16, `@maxhub/max-bot-api` (MIT, 1.1.0), Vitest.

**Тикет:** `.scratch/support-agent/issues/05-max-polling-adapter.md`

**Спецификация:** `.specs/support-agent.md` (копия трекера: `.scratch/support-agent/spec.md`); контракт: `docs/api-contract.md` §0.3 и §5; данные: `docs/data-model.md`; план волны: `docs/plans/wave-1.md`.

## Команда проверки

`npm run test -- tests/integration/05-max-polling-adapter.test.ts`

Команда обязательна к приёмке среза. Юнит-тесты среза — обязательные шаги плана; интеграционный тест собирает их вместе и проверяет срез целиком.

## Общие ограничения

- Код создаётся только в спринте 26.11 19:00 → 28.11 19:00 по Камчатке, после Г3a и отдельного «поехали».
- Срез владеет каталогом `src/channels/max/**`, `src/app/api/max/**`.
- Общие поверхности не меняются: `docs/api-contract.md`, `docs/data-model.md`, роутер, `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`.
- Миграция этого среза — `5000_channel_state.sql`. Номера закрепляет exec.
- Токен бота — только переменные окружения/секретница. Не попадает в репозиторий, журналы, доказательства, описание продукта и переписку.
- Транспорт спринта — Long Polling `GET /updates`. Webhook `POST /subscriptions` требует публичного HTTPS с доверенным TLS и в критерии демо не входит.
- Пул тестовых процессов ограничен: `vitest --pool=forks --poolOptions.forks.maxForks=2`.

## На что обратить внимание при проверке

- Пустое событие без `chat_id` отбрасывается, а не роняет опрос.
- Повторное событие не создаёт второе обращение.
- При результате `escalate` отправки в MAX нет.
- В режиме тени отправки нет ни при каком результате.
- Соблюдается предел 2 сообщения в секунду на диалог.
- Токен не появляется в журналах, отчётах и ошибках.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/channels/max/client.ts` | Тонкий клиент Bot API: Long Polling, отправка сообщения |
| `src/channels/max/normalize.ts` | Нормализация события в сообщение канала |
| `src/channels/max/adapter.ts` | Адаптер канала: старт, опрос, обработка, отправка ответа |
| `src/channels/max/index.ts` | Публичный API адаптера |
| `src/app/api/max/status/route.ts` | Состояние подключения для демо |
| `db/migrations/5000_channel_state.sql` | Таблица `channel_state` |
| `tests/channels/max/normalize.test.ts` | Нормализация входящего события |
| `tests/channels/max/send.test.ts` | Отправка, тень, лимит, отсутствие токена в логах |
| `tests/integration/05-max-polling-adapter.test.ts` | Интеграционный тест среза по команде тикета |

---

### Задача 1: Нормализация входящего события

**Файлы:**
- Создать: `src/channels/max/normalize.ts`, `src/channels/max/index.ts`
- Тест: `tests/channels/max/normalize.test.ts`

**Интерфейсы:**
- Использует: типы событий Bot API MAX.
- Даёт: `normalizeMaxUpdate(update: MaxUpdate): NormalizedMessage | null`.

```ts
type NormalizedMessage = {
  conversationId: string;
  messageId: string;
  channel: "max";
  externalChatId: string | null;
  text: string;
  maskedFieldsCount: number;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/channels/max/normalize.test.ts`**

  Проверки: событие `message_created` нормализуется в сообщение канала с `chat_id`, текстом и идентификатором события; событие без `chat_id` отбрасывается, а не падает; событие другого типа не обрабатывается; `channel` равен `max`.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm run test -- tests/channels/max/normalize.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Реализовать `src/channels/max/normalize.ts`**

  Из события извлекаются `chat_id`, текст сообщения и идентификатор. Текст маскируется модулем маскирования ядра по замороженному контракту; при отсутствии модуля маскирования используется порт из контракта — код среза не дублирует правила ПД, а вызывает порт.

- [ ] **Шаг 4: Реализовать публичный `src/channels/max/index.ts`**

  Экспортируется `normalizeMaxUpdate`. Внутренние файлы не импортируются вне каталога среза.

- [ ] **Шаг 5: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/channels/max/normalize.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 6: Зафиксировать изменения**

```bash
git add src/channels/max/normalize.ts src/channels/max/index.ts tests/channels/max/normalize.test.ts
git commit -m "feat: normalize incoming MAX events for the core"
```

---

### Задача 2: Опрос, отправка ответа и режим тени

**Файлы:**
- Создать: `src/channels/max/client.ts`, `src/channels/max/adapter.ts`, `src/app/api/max/status/route.ts`, `db/migrations/5000_channel_state.sql`
- Тест: `tests/channels/max/send.test.ts`

**Интерфейсы:**
- Использует: порт ядра `runAgent(input): Promise<AgentOutcome>` по замороженному контракту; токен из переменной окружения `MAX_BOT_TOKEN`.
- Даёт: `startMaxAdapter(options: MaxAdapterOptions): Promise<void>`, `stopMaxAdapter(): Promise<void>`, `getMaxStatus(): Promise<MaxStatus>`.

```ts
type MaxAdapterOptions = {
  token: string;
  runAgent: (input: NormalizedMessage) => Promise<AgentOutcome>;
  shadowMode: () => Promise<boolean>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
};

type MaxStatus = {
  running: boolean;
  lastEventAt: string | null;
  lastMarker: number | null;
  shadowMode: boolean;
};
```

- [ ] **Шаг 1: Написать падающий тест `tests/channels/max/send.test.ts`**

  Фикстура: подставной клиент Bot API и подставной `runAgent`. Проверки: при результате `respond` вызывается отправка в тот же `chat_id`; при результате `escalate` отправки нет; в режиме тени отправки нет ни при каком результате; соблюдается предел 2 сообщения в секунду на диалог; повторное событие с тем же идентификатором не создаёт второе обращение; токен отсутствует в перехваченных журналах и в сообщениях об ошибках.

- [ ] **Шаг 2: Запустить тест и убедиться в падении**

  Команда: `npm run test -- tests/channels/max/send.test.ts`
  Ожидание: ПРОВАЛ — модуль не найден.

- [ ] **Шаг 3: Создать миграцию `db/migrations/5000_channel_state.sql`**

  Таблица `channel_state`: `channel`, `external_chat_id`, `marker`, `last_event_at`, `shadow_mode`, `updated_at`. Маркер опроса сохраняется, чтобы перезапуск не терял события.

- [ ] **Шаг 4: Реализовать `src/channels/max/client.ts`**

  Тонкий клиент поверх `@maxhub/max-bot-api`: Long Polling `GET /updates` с маркером, отправка `POST /messages`. Токен передаётся конструктору из переменной окружения и нигде не логируется. Ошибки провайдера не содержат токена.

- [ ] **Шаг 5: Реализовать `src/channels/max/adapter.ts`**

  Опрос событий, нормализация, вызов ядра через порт, отправка ответа только при результате `respond` и только когда режим тени выключен. При исчерпании лимита отправки — пауза. Ошибка опроса приводит к перезапуску с задержкой, без потери маркера.

- [ ] **Шаг 6: Реализовать `src/app/api/max/status/route.ts`**

  Отдаёт состояние подключения для демо: работает ли опрос, когда было последнее событие, включён ли режим тени. Токен не раскрывается.

- [ ] **Шаг 7: Запустить тест и убедиться в прохождении**

  Команда: `npm run test -- tests/channels/max/normalize.test.ts tests/channels/max/send.test.ts`
  Ожидание: ПРОВЕДЕНО.

- [ ] **Шаг 8: Разведка живым ботом**

  Выполняет exec, требуется токен владельца. Шаг 1: `GET /me` с таймбоксом — проверка токена и доступности API. Шаг 2: отправка тестового сообщения в `@se15151074_bot` и проверка ответа.

  Доказательство фиксируется без токена.

- [ ] **Шаг 9: Зафиксировать изменения**

```bash
git add src/channels/max src/app/api/max db/migrations/5000_channel_state.sql tests/channels/max
git commit -m "feat: add MAX channel adapter with polling transport"
```

## Самопроверка плана

- **Покрытие:** задача 1 — нормализация; задача 2 — опрос, отправка, тень, состояние. Все критерии приёмки MAX имеют тест.
- **Шаги:** каждый шаг даёт один проверяемый артефакт; команды указаны с ожидаемым результатом.
- **Типы:** `normalizeMaxUpdate`, `startMaxAdapter`, `getMaxStatus` согласованы с контрактом §0.3.
- **Границы:** срез не трогает ядро, роутер и корневой конфиг; подключение адаптера к ядру делает exec в волне 2.
- **Пропорция:** план задаёт сигнатуры, файлы, тесты и команды; тела реализации оставлены исполнителю.

## Передача

1. Принятая спека и тикет среза MAX-адаптера;
2. Г3a — проверка supervisor с доказательствами;
3. отдельное «поехали» владельца;
4. выбор режима исполнения: субагенты или одна сессия.
