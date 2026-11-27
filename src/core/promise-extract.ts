import type { Source } from "@/contracts/chat";

/**
 * Извлечение обязательства из ответа модели (R11, ADR-0018).
 *
 * Ключевой инвариант: обещание допустимо только из подтверждённого источника.
 * Проверку выполняет код, а не формулировка модели:
 *
 * - список подтверждённых источников должен быть непустым, иначе
 *   `no_confirmed_source`;
 * - источник, названный моделью, должен входить в этот список;
 * - формулировка срока обязана дословно встречаться в тексте источника,
 *   иначе `deadline_not_in_source`;
 * - срок должен быть, иначе `deadline_unapproved`;
 * - в веб-канале адрес обязателен и должен быть корректным, иначе
 *   `contact_email_required` или `invalid_contact_email`.
 *
 * Срок не берётся «на веру» из текста модели: формулировка срока ищется в
 * подтверждённом источнике, и только найденная в источнике величина
 * превращается в `due_at`.
 */

/** Источник, подтверждённый поиском по базе знаний. */
export type ConfirmedSource = {
  kind: Source["kind"];
  id: string;
  text: string;
  title?: string | null;
  location?: string | null;
};

/** Канал доставки обещания: MAX — диалог, email — адрес клиента. */
export type PromiseChannel = "max" | "email";

/**
 * Кандидат в обещание: то, что модель предложила зафиксировать.
 *
 * `contactLabel` — метка email в модели и трассе, `contactEmail` —
 * восстановленное значение, если его удалось получить из таблицы
 * соответствий диалога.
 */
export type PromiseCandidate = {
  /** Текст обязательства. */
  text: string;
  /** Формулировка срока из ответа модели: ищется в тексте источника. */
  deadline: string | null;
  /** Ответственный, если модель его назвала. */
  owner: string | null;
  /** Источник, на который сослалась модель. */
  sourceKind: string | null;
  sourceId: string | null;
  channel: PromiseChannel;
  externalChatId: string | null;
  contactLabel: string | null;
  contactEmail: string | null;
};

/** Обязательство, прошедшее проверку источника. */
export type ExtractedPromise = {
  text: string;
  dueAt: string;
  owner: string;
  sourceKind: string;
  sourceId: string;
  channel: PromiseChannel;
  externalChatId: string | null;
  contactLabel: string | null;
  contactEmail: string | null;
};

export type PromiseRejectionReason =
  | "no_confirmed_source"
  | "deadline_not_in_source"
  | "deadline_unapproved"
  | "invalid_contact_email"
  | "contact_email_required";

export type PromiseExtraction =
  | { kind: "promise"; promise: ExtractedPromise }
  | { kind: "rejected"; reason: PromiseRejectionReason; detail: string };

/** Контекст канала, в котором пришёл ответ. */
export type CandidateContext = {
  channel: "web" | "max";
  externalChatId: string | null;
  /** Замаскированный текст клиента: в нём ищется метка адреса. */
  clientText: string | null;
  /** Восстановленный адрес, если метка найдена в таблице соответствий. */
  contactEmail?: string | null;
};

/** Маркер обещания в ответе модели. */
const PROMISE_MARKER = /обещание\s*:/iu;

/** Ответственный, названный в источнике. */
const OWNER_PATTERN = /ответственн(?:ый|ая|ые)\s*[:—–-]\s*([^\n.;]+)/iu;

/** Формат адреса электронной почты: непустой, есть `@` и домен с точкой. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/u;

/** Метка адреса в замаскированном тексте. */
const EMAIL_LABEL_PATTERN = /⟦EMAIL_\d+⟧/u;

/**
 * Непохожий на адрес фрагмент с `@`: клиент мог написать адрес с опечаткой,
 * и такой текст нельзя ни принять как адрес, ни отправить в модель.
 */
const RAW_EMAIL_PATTERN = /[^\s@,;]+@[^\s@,;]+/u;

type Deadline = {
  /** Формулировка срока как её написала модель. */
  phrase: string;
  /** Вычисленный срок. */
  dueAt: string;
};

/** Единицы длительности срока. */
const DURATION_UNITS: Array<{ pattern: string; milliseconds: number }> = [
  { pattern: "минут", milliseconds: 60_000 },
  { pattern: "час", milliseconds: 3_600_000 },
  { pattern: "дн", milliseconds: 86_400_000 },
  { pattern: "день", milliseconds: 86_400_000 },
  { pattern: "недел", milliseconds: 604_800_000 },
  { pattern: "месяц", milliseconds: 2_592_000_000 },
];

/** Формулировка срока встречается в тексте источника. */
function containsPhrase(sourceText: string, phrase: string): boolean {
  // Нормализация: регистр, пробелы и тире. Иначе «в течение 120 минут» и
  // «в течение  120  минут» считались бы разными формулировками.
  const normalize = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[‐-―−]/gu, "-")
      .replace(/\s+/gu, " ")
      .trim();
  return normalize(sourceText).includes(normalize(phrase));
}

/**
 * Ищет срок в тексте ответа модели.
 *
 * Поддерживаются календарная дата и длительность («120 минут», «3 дня»).
 * Возвращается формулировка целиком: именно она должна дословно найтись в
 * подтверждённом источнике.
 */
function findDeadline(text: string, now: Date): Deadline | null {
  const dateMatch = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/u.exec(text);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const year = Number(dateMatch[3]);
    const dueAt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (!Number.isNaN(dueAt.getTime())) {
      return { phrase: dateMatch[0], dueAt: dueAt.toISOString() };
    }
  }

  for (const unit of DURATION_UNITS) {
    const pattern = new RegExp(
      `(\\d+)\\s*(${unit.pattern}\\w*)`,
      "iu",
    );
    const match = pattern.exec(text);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      phrase: match[0],
      dueAt: new Date(now.getTime() + amount * unit.milliseconds).toISOString(),
    };
  }

  return null;
}

/**
 * Ответственный из текста источника.
 *
 * Если источник ответственного не называет, ответственным остаётся
 * `manager`: имя ответственного не додумывается.
 */
function ownerFromSource(sourceText: string): string | null {
  const match = OWNER_PATTERN.exec(sourceText);
  const owner = match?.[1]?.trim();
  return owner && owner.length > 0 ? owner : null;
}

/** Метка адреса в тексте ответа или в тексте клиента. */
function findEmailLabel(...texts: Array<string | null>): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = EMAIL_LABEL_PATTERN.exec(text);
    if (match) return match[0];
  }
  return null;
}

/** Адрес, который клиент написал без маскирования: такому адресу не доверяют. */
function findRawEmail(...texts: Array<string | null>): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = RAW_EMAIL_PATTERN.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Разбирает ответ модели в кандидат в обещание.
 *
 * Обещание ищется по явному маркеру `ОБЕЩАНИЕ:`: без маркера ответ не
 * содержит обязательства, и фиксировать нечего. Возвращается `null`,
 * если в ответе обещания нет.
 */
export function candidateFromAnswer(
  answerText: string,
  context: CandidateContext,
): PromiseCandidate | null {
  const marker = PROMISE_MARKER.exec(answerText);
  if (!marker) return null;

  const before = answerText.slice(0, marker.index).trim();
  const after = answerText
    .slice(marker.index + marker[0].length)
    .replace(/^[:—–-]\s*/u, "")
    .trim();

  const text = before.length > 0 ? before : after;

  // Срок идёт сразу за маркером; если там его нет, ищем по всему ответу.
  const deadlineSource = after.length > 0 ? after : answerText;
  const deadlineMatch = findDeadline(deadlineSource, new Date());
  const fallbackDeadline =
    deadlineMatch ?? findDeadline(answerText, new Date());

  const sourceMatch = /источник\s*[:—–-]\s*([A-Za-z_]+)\s*[:/]\s*([^\s,;]+)/iu.exec(
    answerText,
  );

  const label = findEmailLabel(text, context.clientText);
  const rawEmail = label ? null : findRawEmail(context.clientText);

  return {
    text,
    deadline: fallbackDeadline?.phrase ?? null,
    owner: null,
    sourceKind: sourceMatch?.[1] ?? null,
    sourceId: sourceMatch?.[2] ?? null,
    channel: context.channel === "max" ? "max" : "email",
    externalChatId: context.channel === "max" ? context.externalChatId : null,
    contactLabel: label,
    contactEmail: label ? (context.contactEmail ?? null) : rawEmail,
  };
}

function rejected(reason: PromiseRejectionReason, detail: string): PromiseExtraction {
  return { kind: "rejected", reason, detail };
}

/**
 * Проверяет кандидата в обещание по подтверждённым источникам.
 *
 * Ни одна проверка не доверяет формулировке модели: источник, срок и
 * ответственный сверяются с текстом источника, адрес — с форматом.
 */
export function extractPromise(
  candidate: PromiseCandidate,
  sources: ConfirmedSource[],
): PromiseExtraction {
  if (sources.length === 0) {
    return rejected(
      "no_confirmed_source",
      "Подтверждённых источников нет — обязательство недопустимо.",
    );
  }

  const now = new Date();
  const deadline = candidate.deadline
    ? findDeadline(candidate.deadline, now)
    : findDeadline(candidate.text, now);
  if (!deadline) {
    return rejected(
      "deadline_unapproved",
      "В обещании нет срока, который можно подтвердить источником.",
    );
  }

  // Источник, названный моделью, должен входить в список подтверждённых.
  let source: ConfirmedSource | null = null;
  if (candidate.sourceId !== null) {
    source =
      sources.find(
        (item) =>
          item.id === candidate.sourceId &&
          (candidate.sourceKind === null || item.kind === candidate.sourceKind),
      ) ?? null;
    if (!source) {
      return rejected(
        "no_confirmed_source",
        "Источник, названный моделью, не входит в список подтверждённых.",
      );
    }
  } else {
    // Модель не назвала источник: подтверждающим считается тот, в тексте
    // которого срок действительно есть. Если такого нет, срок не подтверждён
    // ни одним источником — это отказ, а не «мягкая» догадка.
    source =
      sources.find((item) => containsPhrase(item.text, deadline.phrase)) ?? null;
  }

  if (!source) {
    return rejected(
      "deadline_not_in_source",
      `Срок «${deadline.phrase}» не встречается ни в одном подтверждённом источнике.`,
    );
  }

  if (!containsPhrase(source.text, deadline.phrase)) {
    return rejected(
      "deadline_not_in_source",
      `Срок «${deadline.phrase}» не встречается в тексте подтверждённого источника.`,
    );
  }

  if (candidate.channel === "email") {
    if (candidate.contactLabel === null && candidate.contactEmail === null) {
      return rejected(
        "contact_email_required",
        "В веб-канале адрес клиента обязателен: без него обещание не создаётся.",
      );
    }
    if (candidate.contactEmail === null) {
      return rejected(
        "contact_email_required",
        "Адрес клиента не восстановлен из таблицы соответствий.",
      );
    }
    if (!EMAIL_PATTERN.test(candidate.contactEmail)) {
      return rejected(
        "invalid_contact_email",
        "Адрес клиента не проходит проверку формата.",
      );
    }
  }

  const owner = ownerFromSource(source.text) ?? "manager";

  return {
    kind: "promise",
    promise: {
      text: candidate.text,
      dueAt: deadline.dueAt,
      owner,
      sourceKind: source.kind,
      sourceId: source.id,
      channel: candidate.channel,
      externalChatId: candidate.externalChatId,
      contactLabel: candidate.contactLabel,
      contactEmail: candidate.contactEmail,
    },
  };
}
