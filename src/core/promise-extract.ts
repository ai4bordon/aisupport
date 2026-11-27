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
 *
 * Формат обязательства в ответе модели — отдельная строка-маркер:
 *
 * ```
 * ОБЕЩАНИЕ: Отправить КП | срок: 12.03.2026 | источник: [1]
 * ```
 *
 * Маркер живёт в тексте ответа модели, а не в отдельном поле JSON: общий
 * разбор ответа провайдера (`src/core/model.ts`) отдаёт только текст, суммы и
 * цитаты, и трогать его срез не имеет права. Строка маркера вырезается из
 * ответа клиенту, а на её место встаёт обязательство с подтверждённым
 * сроком — но формулировку обязательства задаёт модель, а не шаблон кода.
 *
 * Три правила, которые модуль держит после волны исправлений
 * (BUGSAUDIT-2026-11-27.md, находки B8, C18, C19):
 *
 * - обязательство без строки-маркера не остаётся незамеченным: ядро видит
 *   его в тексте ответа и знает, что обязательство не подтверждено
 *   (`findUnmarkedCommitment`, `unconfirmedCommitmentRejection`);
 * - формулировку модели код не переписывает: текст обещания сохраняет
 *   слова модели, а код добавляет подтверждённый срок и адресата
 *   (`promiseSentence`);
 * - маркер вырезается целиком и во всех вхождениях, в том числе когда он
 *   стоит не в начале строки (`stripPromiseMarker`).
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
  /** Формулировка срока так, как она написана в источнике. */
  deadlinePhrase: string;
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

/** Ответственный, названный в источнике. */
const OWNER_PATTERN = /ответственн(?:ый|ая|ые)\s*[:—–-]\s*([^\n.;]+)/iu;

/** Формат адреса электронной почты: непустой, есть `@` и домен с точкой. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/u;

/** Метка адреса в замаскированном тексте. */
const EMAIL_LABEL_PATTERN = /⟦EMAIL_\d+⟧/u;

/**
 * Строка-маркер обязательства в ответе модели.
 *
 * Маркер распознаётся в любом месте строки, а не только в её начале: модель
 * дописывает его в конец абзаца, и такой ответ обязан быть виден ядру.
 * Правая граница — конец строки: всё, что идёт после маркера в той же
 * строке, к маркеру не относится.
 *
 * Флаг `g` обязателен: маркер встречается в ответе больше одного раза, и
 * ядру нужен каждый из них (C19).
 */
const PROMISE_MARKER = /^[ \t]*ОБЕЩАНИЕ[ \t]*:[ \t]*(.*)$/gmu;

/**
 * Тот же маркер без глобального флага: разбор одной строки.
 *
 * Отдельная константа нужна, потому что глобальный регулярный выражение
 * хранит позицию последнего совпадения и второй вызов `exec` на нём
 * вернёт `null` вместо разбора.
 */
const PROMISE_MARKER_LINE = /^[ \t]*ОБЕЩАНИЕ[ \t]*:[ \t]*(.*)$/mu;

/**
 * Глаголы обязательства: ответ модели, в котором агент берёт на себя срок.
 *
 * Список закрытый: найденный глагол без срока обязательства не создаёт —
 * подтверждать нечего. Но найденный глагол со сроком означает, что
 * обязательство в ответе есть, даже если модель не написала строку-маркер.
 */
const COMMITMENT_VERBS = [
  "пришл",
  "отправ",
  "вышл",
  "направ",
  "достав",
  "подготов",
  "оформ",
  "выстав",
  "выдам",
  "выдадим",
  "постав",
  "отгруз",
  "сдела",
  "созда",
  "выпуст",
  "верну",
  "перезвон",
  "свяж",
] as const;

/**
 * Слово-формулировка срока: «120 минут», «3 дня», «12.03.2026».
 *
 * Та же грамматика, что у `findDeadline`: календарная дата либо
 * длительность. Срок ищется в тексте ответа, чтобы найти обязательство,
 * которое модель сформулировала словами, без строки-маркера.
 */
const DEADLINE_HINT =
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b|\b\d+\s*(?:минут\w*|час\w*|дн\w*|день\w*|недел\w*|месяц\w*)/iu;

/**
 * Намеренность обязательства: «в течение», «не позднее», «через», «за».
 *
 * Без этих слов «лицензия выдаётся за 120 минут» — описание условия из
 * источника, а не обещание агента. Намеренность отличает обязательство от
 * пересказа условия.
 */
const COMMITMENT_INTENT =
  /\b(?:в\s+течение|в\s+течении|не\s+позднее|не\s+позже|через|до|за|отправлю|пришлю|вышлю|направлю|подготовлю|оформлю|выдам|поставлю|сделаю|создам|выпущу|перезвоню|свяжусь|пришлем|отправим|подготовим|оформим|поставим|выдадим)\b/iu;

/**
 * Обязательство, найденное в тексте ответа без строки-маркера.
 *
 * `text` — фраза модели, `deadline` — формулировка срока как она написана
 * в тексте, `dueAt` — вычисленный срок.
 */
export type UnmarkedCommitment = {
  /** Фраза обязательства: предложение текста, где агент что-то обещает. */
  text: string;
  /** Формулировка срока из текста ответа. */
  deadline: string;
  /** Срок, вычисленный из формулировки. */
  dueAt: string;
};

/**
 * Результат поиска обязательств в ответе модели.
 *
 * `marker` — разобранная строка-маркер, `unmarked` — обязательство, найденное
 * словами. Оба поля могут быть `null`: ответ без обязательств.
 */
export type CommitmentSearch = {
  marker: PromiseMarker | null;
  unmarked: UnmarkedCommitment | null;
};

/** Ссылка на источник по номеру в подсказке промпта: `[1]`. */
const SOURCE_REF_PATTERN = /^\[(\d+)\]$/u;

/**
 * Единицы длительности срока.
 *
 * Порядок важен: «минуты» проверяется раньше «минут», иначе короткая форма
 * съела бы длинную.
 */
const DURATION_UNITS: Array<{ pattern: string; milliseconds: number }> = [
  { pattern: "минут\\w*", milliseconds: 60_000 },
  { pattern: "час\\w*", milliseconds: 3_600_000 },
  { pattern: "дн\\w*", milliseconds: 86_400_000 },
  { pattern: "день\\w*", milliseconds: 86_400_000 },
  { pattern: "недел\\w*", milliseconds: 604_800_000 },
  { pattern: "месяц\\w*", milliseconds: 2_592_000_000 },
];

/**
 * Формулировка срока встречается в тексте источника.
 *
 * Нормализация: регистр, пробелы и тире. Иначе «в течение 120 минут» и
 * «в течение  120  минут» считались бы разными формулировками.
 */
function containsPhrase(sourceText: string, phrase: string): boolean {
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[‐-―−]/gu, "-")
      .replace(/\s+/gu, " ")
      .trim();
  return normalize(sourceText).includes(normalize(phrase));
}

type Deadline = {
  /** Формулировка срока как её написала модель. */
  phrase: string;
  /** Вычисленный срок. */
  dueAt: string;
};

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
    const match = new RegExp(`(\\d+)\\s*(${unit.pattern})`, "iu").exec(text);
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

/** Разобранная строка-маркер обязательства. */
export type PromiseMarker = {
  text: string;
  deadline: string | null;
  sourceRef: number | null;
};

/**
 * Разбирает строку-маркер обязательства.
 *
 * Формат: `ОБЕЩАНИЕ: <текст> | срок: <формулировка> | источник: [N]`.
 * Неизвестные части игнорируются: обязательство не должно появляться из
 * текста, который ядро не понимает.
 *
 * Разбирается одна строка: маркер может стоять в любом месте строки, и
 * текст после него на той же строке относится к маркеру.
 */
function parsePromiseMarker(line: string): PromiseMarker | null {
  const match = PROMISE_MARKER_LINE.exec(line);
  const body = match?.[1];
  if (body === undefined) return null;

  let text = "";
  let deadline: string | null = null;
  let sourceRef: number | null = null;

  for (const part of body.split("|")) {
    const segment = part.trim();
    if (segment.length === 0) continue;
    const deadlineMatch = /^срок\s*:\s*(.+)$/iu.exec(segment);
    if (deadlineMatch) {
      deadline = deadlineMatch[1]?.trim() ?? null;
      continue;
    }
    const sourceMatch = /^источник\s*:\s*(.+)$/iu.exec(segment);
    if (sourceMatch) {
      const ref = SOURCE_REF_PATTERN.exec(sourceMatch[1]?.trim() ?? "");
      sourceRef = ref ? Number(ref[1]) : null;
      continue;
    }
    if (text.length === 0) text = segment;
  }

  if (text.length === 0 && deadline === null) return null;
  return { text, deadline, sourceRef };
}

/**
 * Ищет строку-маркер обязательства в ответе модели.
 *
 * Возвращается первый маркер: обязательств в ответе быть не должно, а
 * второе обязательство в том же ответе — повод для отказа, а не запись
 * второй строки в журнал.
 */
function findPromiseMarker(answerText: string): PromiseMarker | null {
  for (const line of answerText.split(/\r?\n/u)) {
    const marker = parsePromiseMarker(line);
    if (marker) return marker;
  }
  return null;
}

/**
 * Предложение текста ответа, в котором агент что-то обещает.
 *
 * Ищется предложение с глаголом обязательства и формулировкой срока.
 * Намеренность («в течение», «не позднее») — обязательное условие: фраза
 * «лицензия выдаётся за 120 минут» описывает условие из источника, а
 * «пришлю КП в течение 120 минут» — обещание агента.
 */
function findCommitmentSentence(text: string): string | null {
  for (const raw of text.split(/[\n.;!?]+/u)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;

    const hasVerb = COMMITMENT_VERBS.some((verb) =>
      sentence.toLowerCase().includes(verb),
    );
    if (!hasVerb) continue;
    if (!DEADLINE_HINT.test(sentence)) continue;
    if (!COMMITMENT_INTENT.test(sentence)) continue;

    return sentence;
  }
  return null;
}

/**
 * Обязательство в ответе модели без строки-маркера.
 *
 * Модель взяла на себя срок словами, но не написала строку-маркер: такое
 * обязательство не подтверждено и в журнал не попадает, но ядро обязано
 * знать о нём (B8). Возвращается `null`, если обязательства в тексте нет.
 */
export function findUnmarkedCommitment(
  answerText: string,
  now: Date = new Date(),
): UnmarkedCommitment | null {
  const sentence = findCommitmentSentence(answerText);
  if (sentence === null) return null;

  const deadline = findDeadline(sentence, now);
  if (!deadline) return null;

  return { text: sentence, deadline: deadline.phrase, dueAt: deadline.dueAt };
}

/**
 * Обязательства в ответе модели: по маркеру и без него.
 *
 * Общий поиск для обоих случаев (B8): маркер — оформленное обязательство,
 * `unmarked` — обязательство словами. Поле `unmarked` заполняется, только
 * если маркера нет: ответ с маркером разбирается маркером.
 */
export function findCommitments(
  answerText: string,
  now: Date = new Date(),
): CommitmentSearch {
  const marker = findPromiseMarker(answerText);
  if (marker) return { marker, unmarked: null };
  return { marker: null, unmarked: findUnmarkedCommitment(answerText, now) };
}

/**
 * Отказ по обязательству, которое модель сформулировала без маркера.
 *
 * Причина единая с отказом по неподтверждённому обязательству: обязательство
 * есть, а подтверждения нет. `detail` объясняет менеджеру, что именно
 * нашлось в тексте ответа.
 */
export function unconfirmedCommitmentRejection(
  commitment: UnmarkedCommitment,
): { reason: PromiseRejectionReason; detail: string } {
  return {
    reason: "no_confirmed_source",
    detail:
      `В тексте ответа есть обязательство без строки-маркера ` +
      `«${commitment.text}» со сроком «${commitment.deadline}»: ` +
      `подтверждения источником нет, обещание не фиксируется.`,
  };
}

/**
 * Разбирает ответ модели в кандидат в обещание.
 *
 * Обещание ищется по строке-маркеру: без неё ответ не содержит
 * подтверждённого обязательства, и фиксировать нечего. Возвращается
 * `null`, если в ответе маркера нет.
 *
 * Ответ, в котором обязательство есть, но маркера нет, — не «ничего не
 * найдено»: его ловит `findUnmarkedCommitment`, и ядро отказывает по нему
 * (B8). Здесь такой ответ остаётся `null` — подтверждённого обязательства
 * из него не получить.
 */
export function candidateFromAnswer(
  answerText: string,
  context: CandidateContext,
  sources: ConfirmedSource[] = [],
): PromiseCandidate | null {
  const marker = findPromiseMarker(answerText);
  if (!marker) return null;

  // Адрес клиента — персональные данные: в модель и трассу уходит метка,
  // а исходное значение лежит в таблице соответствий и приходит в ядро
  // отдельно. Сырой адрес из текста не принимается: он не прошёл бы
  // маскирование и не оказался бы в таблице соответствий.
  const label = findEmailLabel(marker.text, context.clientText);
  const contactEmail = context.contactEmail ?? null;

  // Номер источника из подсказки промпта превращается в идентификатор
  // подтверждённого источника: модель не может сослаться на источник,
  // которого нет в списке.
  const referenced =
    marker.sourceRef !== null ? sources[marker.sourceRef - 1] : undefined;

  return {
    text: marker.text,
    deadline: marker.deadline,
    owner: null,
    sourceKind: referenced?.kind ?? null,
    sourceId: referenced?.id ?? null,
    channel: context.channel === "max" ? "max" : "email",
    externalChatId: context.channel === "max" ? context.externalChatId : null,
    contactLabel: label,
    contactEmail,
  };
}

/**
 * Заменяет строку-маркер обязательства в тексте ответа.
 *
 * Клиенту маркер не показывается: это внутренний формат, по которому ядро
 * понимает, что модель взяла обязательство. На его место встаёт
 * обязательство с подтверждённым сроком — иначе клиент получил бы текст
 * модели, который может содержать неподтверждённые детали.
 *
 * Удаляются ВСЕ вхождения маркера, а не только первое (C19): модель может
 * дописать маркер дважды, и служебная строка не должна попасть к клиенту.
 * Маркер распознаётся и тогда, когда стоит не в начале строки: текст перед
 * ним на той же строке клиенту остаётся, а сам маркер вырезается.
 */
export function stripPromiseMarker(answerText: string, replacement = ""): string {
  let inserted = false;
  const stripped = answerText
    .replace(PROMISE_MARKER, (_match, prefix: string, body: string) => {
      // Первое вхождение маркера заменяется текстом обязательства; остальные
      // вырезаются целиком: два обязательства в одном ответе клиенту не
      // показываются.
      if (!inserted && replacement.length > 0) {
        inserted = true;
        return prefix.length > 0 ? `${prefix}\n${replacement}` : `\n${replacement}`;
      }
      // Хвост строки после маркера принадлежит маркеру: и текст обязательства,
      // и служебные части `срок:`/`источник:` клиенту не показываются.
      void body;
      return prefix === "\n" ? "\n" : "";
    })
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return stripped;
}

/**
 * Дата срока в виде, понятном клиенту: `27.11.2026`.
 *
 * Формат выбран один и тот же для обоих каналов: клиент и менеджер должны
 * видеть один и тот же срок, а не разные записи одного момента времени.
 */
export function formatDueDate(dueAt: string): string {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return dueAt;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

/**
 * Текст обязательства для клиента.
 *
 * Формулировку задаёт код, а не модель: в веб-канале адрес подставляется
 * меткой (`⟦EMAIL_1⟧`), в MAX адресатом называется диалог. Один и тот же
 * текст уходит клиенту и попадает в журнал — менеджер видит ровно то, что
 * пообещали.
 */
export function promiseSentence(
  promise: Pick<ExtractedPromise, "channel" | "contactLabel" | "dueAt">,
): string {
  const due = formatDueDate(promise.dueAt);
  if (promise.channel === "email") {
    const contact = promise.contactLabel ?? "указанный адрес";
    return `Счёт будет отправлен на ${contact} до ${due}`;
  }
  return `КП будет готово до ${due}, пришлю сюда`;
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

  const owner = ownerFromSource(source.text) ?? candidate.owner ?? "manager";

  return {
    kind: "promise",
    promise: {
      text: candidate.text,
      dueAt: deadline.dueAt,
      deadlinePhrase: deadline.phrase,
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
