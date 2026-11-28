import { getPool } from "@/db/pool";
import { createMaskMappingStore } from "@/core/mask-store";

/**
 * Публичный API модуля обещаний (docs/api-contract.md §1, §3).
 *
 * Модуль владеет таблицей `promises`: наружу отдаются `recordPromise`,
 * `listPromises` и `markPromiseDone`, доступ к `pg` остаётся внутри.
 *
 * Кроме журнала модуль держит сценарий «менеджер заказал документ»: клиент
 * даёт адрес получателя, адрес проверяется, обещание пишется в журнал с
 * каналом `email`; если клиент отказался от адреса, работает запасной путь
 * «пришлю ссылку в чат» — канал `max`, адресат — диалог.
 *
 * Внешних интеграций доставки нет: ни SMTP, ни CRM, ни MAX из модуля не
 * вызываются, `reminded_at` не заполняется. Менеджер видит обещание в
 * журнале и отмечает его выполненным руками.
 */

/** Статус обещания: `open` — в работе, `done` — выполнено, `overdue` — просрочено. */
export type PromiseStatus = "open" | "done" | "overdue";

/** Канал доставки: MAX — адресат диалог, email — адресат адрес клиента. */
export type PromiseChannel = "max" | "email";

/** Запись журнала обещаний. */
export type PromiseRecord = {
  id: string;
  tenantId: string;
  conversationId: string;
  text: string;
  dueAt: string;
  owner: string;
  status: PromiseStatus;
  sourceKind: string | null;
  sourceId: string | null;
  isSynthetic: boolean;
  channel: PromiseChannel;
  contactEmail: string | null;
  contactLabel: string | null;
  externalChatId: string | null;
  remindedAt: string | null;
  createdAt: string;
};

/** Данные новой записи обещания. */
export type RecordPromiseInput = {
  tenantId: string;
  conversationId: string;
  text: string;
  dueAt: string;
  owner: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  isSynthetic?: boolean;
  channel?: PromiseChannel;
  contactEmail?: string | null;
  contactLabel?: string | null;
  externalChatId?: string | null;
};

/** Фильтр журнала обещаний. */
export type ListPromisesFilter = {
  tenantId: string;
  status?: PromiseStatus;
  conversationId?: string;
  /** Канал доставки: только `email` или только `max`. */
  channel?: PromiseChannel;
};

/**
 * Вид документа, который менеджер обещает подготовить.
 */
export type PromiseDocumentKind = "quote" | "invoice";

/**
 * Куда менеджер доставит документ.
 *
 * `email` — адрес клиента: адрес проверяется до записи обещания, сырой
 * адрес попадает в `contact_email`, а в текст обещания — только метка.
 *
 * `chat` — запасной путь «пришлю ссылку в чат»: адрес не нужен, адресатом
 * остаётся диалог, канал — `max`.
 */
export type PromiseDelivery =
  | { kind: "email"; email: string; label?: string | null }
  | { kind: "chat"; externalChatId?: string | null };

/**
 * Срок обещания — относительный отрезок от момента записи.
 *
 * Срок в днях задаёт, через сколько дней документ будет готов; минуты и
 * часы нужны для коротких обещаний вроде «в течение 15 минут».
 */
export type PromiseTerm = {
  days?: number;
  hours?: number;
  minutes?: number;
};

/**
 * Данные записи обещания по заказанному документу.
 */
export type RecordDocumentPromiseInput = {
  tenantId: string;
  conversationId: string;
  /** Вид документа: КП или счёт. */
  documentKind: PromiseDocumentKind;
  /** Срок, отсчитываемый от момента записи. */
  term: PromiseTerm;
  /** Ответственный. По умолчанию — `manager`. */
  owner?: string;
  /** Куда доставляем: по адресу или ссылкой в чат. */
  delivery: PromiseDelivery;
  /** Текст обещания. По умолчанию — формулировка кода. */
  text?: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  isSynthetic?: boolean;
};

/**
 * Коды отказа записи обещания.
 */
export type PromiseValidationCode =
  | "invalid_contact_email"
  | "invalid_term"
  | "invalid_document_kind";

/**
 * Отказ записи обещания с объяснением по-русски.
 *
 * Ошибка не «съедается» вызывающим кодом: клиент должен понимать, что
 * именно не так с адресом, а менеджер — видеть причину в логе.
 */
export class PromiseValidationError extends Error {
  readonly code: PromiseValidationCode;

  constructor(code: PromiseValidationCode, message: string) {
    super(message);
    this.name = "PromiseValidationError";
    this.code = code;
  }
}

/**
 * Результат проверки адреса электронной почты.
 */
export type EmailValidation =
  | { ok: true; email: string }
  | { ok: false; error: string };

type PromiseRow = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  text: string;
  due_at: Date;
  owner: string;
  status: PromiseStatus;
  source_kind: string | null;
  source_id: string | null;
  is_synthetic: boolean;
  channel: PromiseChannel;
  contact_email: string | null;
  contact_label: string | null;
  external_chat_id: string | null;
  reminded_at: Date | null;
  created_at: Date;
};

function toRecord(row: PromiseRow): PromiseRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    text: row.text,
    dueAt: row.due_at.toISOString(),
    owner: row.owner,
    status: row.status,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    isSynthetic: row.is_synthetic,
    channel: row.channel,
    contactEmail: row.contact_email,
    contactLabel: row.contact_label,
    externalChatId: row.external_chat_id,
    remindedAt: row.reminded_at === null ? null : row.reminded_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Метка адреса по умолчанию.
 *
 * Адрес — персональные данные: в тексте обещания, который видят модель,
 * трасса и журнал, стоит метка, а исходное значение лежит в
 * `contact_email` и восстанавливается по метке при фактической отправке.
 */
const DEFAULT_EMAIL_LABEL = "⟦EMAIL_1⟧";

/**
 * Ответственный по умолчанию: заказ документа делает менеджер.
 */
const DEFAULT_OWNER = "manager";

/**
 * Формат адреса электронной почты: непустой, есть `@` и домен с точкой.
 *
 * Тот же формат, что и в `src/core/promise-extract.ts`: адрес проверяется
 * по одному правилу в проекте, иначе модуль ядра и модуль обещаний
 * принимали бы разные адреса.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/u;

/**
 * Проверяет адрес электронной почты.
 *
 * Ошибка объясняется по-русски и называет, что именно не так: клиент
 * читает её в чате и должен понять, как исправить адрес, а не просто
 * получить «невалидный ввод».
 */
export function validateContactEmail(email: string): EmailValidation {
  const value = email.trim();

  if (value.length === 0) {
    return {
      ok: false,
      error:
        "Укажите адрес, на который отправить документ: например, client@example.com",
    };
  }

  if (value.includes(" ")) {
    return {
      ok: false,
      error:
        "В адресе не должно быть пробелов. Напишите адрес целиком, например client@example.com",
    };
  }

  const at = value.indexOf("@");

  if (at < 0) {
    return {
      ok: false,
      error:
        "Похоже, в адресе опечатка: не хватает «@». Напишите адрес целиком, например client@example.com",
    };
  }

  if (at === 0) {
    return {
      ok: false,
      error:
        "Перед «@» должно быть имя почтового ящика. Напишите адрес целиком, например client@example.com",
    };
  }

  if (value.indexOf("@", at + 1) >= 0) {
    return {
      ok: false,
      error:
        "В адресе больше одного «@». Напишите адрес целиком, например client@example.com",
    };
  }

  const domain = value.slice(at + 1);

  if (domain.length === 0) {
    return {
      ok: false,
      error:
        "Похоже, в адресе опечатка: не хватает домена после «@». Напишите адрес целиком, например client@example.com",
    };
  }

  if (!domain.includes(".")) {
    return {
      ok: false,
      error:
        "Похоже, в адресе опечатка: в домене не хватает точки. Напишите адрес целиком, например client@example.com",
    };
  }

  if (!EMAIL_PATTERN.test(value)) {
    return {
      ok: false,
      error:
        "Адрес выглядит неверно. Напишите его целиком, например client@example.com",
    };
  }

  return { ok: true, email: value };
}

/**
 * Русская форма числительного: `1 день`, `2 дня`, `5 дней`.
 */
function plural(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Единицы срока и их названия.
 */
const TERM_UNITS: Array<{
  key: "days" | "hours" | "minutes";
  one: string;
  few: string;
  many: string;
  milliseconds: number;
}> = [
  { key: "days", one: "день", few: "дня", many: "дней", milliseconds: 86_400_000 },
  { key: "hours", one: "час", few: "часа", many: "часов", milliseconds: 3_600_000 },
  {
    key: "minutes",
    one: "минута",
    few: "минуты",
    many: "минут",
    milliseconds: 60_000,
  },
];

/**
 * Нормализует срок: целые единицы, без дробей и отрицательных значений.
 *
 * Формулировка срока и момент срока считаются из одного и того же
 * нормализованного значения: иначе клиент прочитал бы «15 минут», а в
 * журнале лежал бы срок в 15 минут 40 секунд.
 */
function normalizeTerm(term: PromiseTerm): Array<{ unit: (typeof TERM_UNITS)[number]; count: number }> {
  const normalized: Array<{ unit: (typeof TERM_UNITS)[number]; count: number }> = [];

  for (const unit of TERM_UNITS) {
    const value = term[unit.key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new PromiseValidationError(
        "invalid_term",
        "Срок обещания должен быть положительным числом: укажите, через сколько дней, часов или минут документ будет готов.",
      );
    }
    const count = Math.floor(value);
    if (count > 0) normalized.push({ unit, count });
  }

  if (normalized.length === 0) {
    throw new PromiseValidationError(
      "invalid_term",
      "Срок обещания должен быть положительным числом: укажите, через сколько дней, часов или минут документ будет готов.",
    );
  }

  return normalized;
}

/**
 * Срок обещания по-русски: «15 минут», «2 дня», «1 день 2 часа».
 */
export function formatPromiseTerm(term: PromiseTerm): string {
  const parts: string[] = [];
  for (const { unit, count } of normalizeTerm(term)) {
    parts.push(`${count} ${plural(count, unit.one, unit.few, unit.many)}`);
  }
  return parts.join(" ");
}

/**
 * Момент срока по сроку в днях, часах и минутах.
 */
export function termDueAt(term: PromiseTerm, from: Date = new Date()): string {
  let milliseconds = 0;
  for (const { unit, count } of normalizeTerm(term)) {
    milliseconds += count * unit.milliseconds;
  }

  return new Date(from.getTime() + milliseconds).toISOString();
}

/**
 * Название документа по-русски: КП или счёт.
 */
const DOCUMENT_NAMES: Record<PromiseDocumentKind, string> = {
  quote: "КП",
  invoice: "счёт",
};

/**
 * Вопрос клиенту об адресе получателя.
 *
 * Клиенту показывается подтверждение вида «КП подготовим в течение 15 минут.
 * На какой email отправить?» — срок уже назван, а адрес ещё не получен.
 */
export function documentPromiseQuestion(
  documentKind: PromiseDocumentKind,
  term: PromiseTerm,
): string {
  const name = DOCUMENT_NAMES[documentKind];
  const phrase = formatPromiseTerm(term);
  return `${name} подготовим в течение ${phrase}. На какой email отправить?`;
}

/**
 * Формулировка запасного пути: клиент отказался от адреса.
 *
 * Адрес не нужен: документ менеджер пришлёт ссылкой в тот же чат, канал
 * доставки — `max`, адресатом остаётся диалог.
 */
export function chatDeliveryAgreement(
  documentKind: PromiseDocumentKind,
  term: PromiseTerm,
): string {
  const name = DOCUMENT_NAMES[documentKind];
  const phrase = formatPromiseTerm(term);
  return `${name} подготовим в течение ${phrase}, пришлю ссылку в чат.`;
}

/**
 * Записывает обещание.
 *
 * Запись изолирована по `tenant_id`: обещание одного арендатора не должно
 * попасть в журнал другого.
 */
export async function recordPromise(input: RecordPromiseInput): Promise<PromiseRecord> {
  const result = await getPool().query<PromiseRow>(
    `INSERT INTO promises
       (tenant_id, conversation_id, text, due_at, owner, status,
        source_kind, source_id, is_synthetic,
        channel, contact_email, contact_label, external_chat_id)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      input.tenantId,
      input.conversationId,
      input.text,
      input.dueAt,
      input.owner,
      input.sourceKind ?? null,
      input.sourceId ?? null,
      input.isSynthetic ?? false,
      input.channel ?? "max",
      input.contactEmail ?? null,
      input.contactLabel ?? null,
      input.externalChatId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("запись обещания не создана");
  return toRecord(row);
}

/**
 * Записывает обещание по заказанному документу.
 *
 * Сценарий: менеджер заказал КП или счёт → клиенту показано подтверждение
 * с вопросом об адресе → клиент ввёл адрес → адрес проверен → обещание
 * записано в журнал (канал `email`, адрес, срок, ответственный `manager`,
 * статус `open`).
 *
 * Запасной путь: клиент отказался или адрес не подошёл → доставка ссылкой
 * в чат (канал `max`, адрес не нужен).
 *
 * Адрес проверяется до записи: неверный адрес не создаёт запись, а
 * возвращает `PromiseValidationError` с объяснением по-русски. В текст
 * обещания попадает метка адреса, а исходное значение — в `contact_email`.
 */
export async function recordDocumentPromise(
  input: RecordDocumentPromiseInput,
): Promise<PromiseRecord> {
  // Ответственный по умолчанию — менеджер: заказ документа делает он.
  const owner = input.owner?.trim() || DEFAULT_OWNER;

  if (input.documentKind !== "quote" && input.documentKind !== "invoice") {
    throw new PromiseValidationError(
      "invalid_document_kind",
      "Вид документа должен быть «quote» (КП) или «invoice» (счёт).",
    );
  }

  const dueAt = termDueAt(input.term);

  if (input.delivery.kind === "email") {
    const validation = validateContactEmail(input.delivery.email);
    if (!validation.ok) {
      throw new PromiseValidationError("invalid_contact_email", validation.error);
    }

    const label = input.delivery.label?.trim() || DEFAULT_EMAIL_LABEL;
    const text =
      input.text?.trim() ||
      `${DOCUMENT_NAMES[input.documentKind]} подготовим в течение ${formatPromiseTerm(
        input.term,
      )}, отправим на ${label}.`;

    // Метка и исходное значение связаны в таблице соответствий диалога:
    // без неё `resolveContactEmail` не восстановит адрес, а подстановка
    // при отправке оставила бы клиенту метку вместо его адреса.
    await createMaskMappingStore(getPool()).save(input.conversationId, {
      [label]: validation.email,
    });

    return recordPromise({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      text,
      dueAt,
      owner,
      sourceKind: input.sourceKind ?? null,
      sourceId: input.sourceId ?? null,
      isSynthetic: input.isSynthetic ?? false,
      channel: "email",
      contactEmail: validation.email,
      contactLabel: label,
      externalChatId: null,
    });
  }

  const text =
    input.text?.trim() || chatDeliveryAgreement(input.documentKind, input.term);

  return recordPromise({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    text,
    dueAt,
    owner,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    isSynthetic: input.isSynthetic ?? false,
    // Адресат — диалог: клиент отказался от адреса, документ придёт
    // ссылкой в чат.
    channel: "max",
    contactEmail: null,
    contactLabel: null,
    externalChatId: input.delivery.externalChatId ?? null,
  });
}

/**
 * Переводит просроченные обещания в статус `overdue` и фиксирует это
 * в базе.
 *
 * Просрочка — вычисляемое состояние, а не фоновая задача: внешний
 * планировщик не нужен, `reminded_at` не заполняется.
 */
export async function markOverdue(tenantId: string): Promise<number> {
  const result = await getPool().query(
    `UPDATE promises
        SET status = 'overdue'
      WHERE tenant_id = $1
        AND status = 'open'
        AND due_at < now()`,
    [tenantId],
  );
  return result.rowCount ?? 0;
}

/**
 * Журнал обещаний арендатора.
 *
 * Перед выдачей просроченные записи переводятся в `overdue`, чтобы менеджер
 * видел актуальный статус, а не вычислял его сам.
 */
export async function listPromises(
  filter: ListPromisesFilter,
): Promise<PromiseRecord[]> {
  await markOverdue(filter.tenantId);

  const conditions = ["tenant_id = $1"];
  const values: unknown[] = [filter.tenantId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.conversationId !== undefined) {
    values.push(filter.conversationId);
    conditions.push(`conversation_id = $${values.length}`);
  }
  if (filter.channel !== undefined) {
    values.push(filter.channel);
    conditions.push(`channel = $${values.length}`);
  }

  const result = await getPool().query<PromiseRow>(
    `SELECT * FROM promises
      WHERE ${conditions.join(" AND ")}
      ORDER BY due_at ASC, created_at ASC`,
    values,
  );
  return result.rows.map(toRecord);
}

/**
 * Отмечает обещание выполненным: менеджер вручную подтверждает отправку.
 *
 * Реальной отправки нет — ни SMTP, ни CRM, ни MAX из модуля не вызываются.
 */
export async function markPromiseDone(id: string, tenantId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE promises SET status = 'done' WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Восстанавливает адрес клиента по метке из таблицы соответствий диалога.
 *
 * Адрес — персональные данные: в модель и трассу уходит метка, исходное
 * значение лежит в `conversation_mask` и подставляется только при фактической
 * отправке. Здесь значение читается сервером для записи в журнал — там оно и
 * нужно менеджеру как адресат.
 *
 * Если метки в таблице нет, адрес не восстанавливается: подставлять
 * «похожий» адрес по догадке нельзя.
 */
export async function resolveContactEmail(
  conversationId: string,
  label: string,
): Promise<string | null> {
  const store = createMaskMappingStore(getPool());
  const mapping = await store.load(conversationId);
  return mapping[label] ?? null;
}
