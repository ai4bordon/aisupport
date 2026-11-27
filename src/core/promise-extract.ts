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
 *   `contact_email_required` или `invalid_contact_email`;
 * - обязательство, написанное моделью словами, без строки-маркера,
 *   недопустимо: подтверждения нет, иначе `promise_not_confirmed`.
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
  | "contact_email_required"
  /** Обязательство есть, а подтверждения нет: строка-маркер не написана (B8). */
  | "promise_not_confirmed";

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
 * Для вырезания из текста: маркер вместе со всем, что стоит справа от
 * него до конца строки, — это внутренний формат, клиенту он не показывается.
 * Обязательный маркер стоит в начале строки; `\n[ \t]*` перед ним убирает
 * перенос строки, чтобы при замене не оставалось пустой строки.
 *
 * `(?<!\p{L}\p{N})` — маркер отдельным словом: «ОБЕЩАНИЕ» внутри слова
 * («обещание») маркером не считается. Lookbehind не съедает символ перед
 * маркером, поэтому текст до маркера на той же строке сохраняется.
 *
 * Флаг `g` обязателен: маркер встречается в ответе больше одного раза, и
 * вырезать надо каждый из них (C19).
 */
const PROMISE_MARKER =
  /(?:\n[ \t]*)?(?<!\p{L}\p{N})ОБЕЩАНИЕ[ \t]*:[ \t]*(.*)$/gmu;

/**
 * Тот же маркер без глобального флага: разбор одной строки.
 *
 * Отдельная константа нужна, потому что глобальное регулярное выражение
 * хранит позицию последнего совпадения и второй вызов `exec` на нём
 * вернёт `null` вместо разбора.
 */
const PROMISE_MARKER_LINE = /(?<!\p{L}\p{N})ОБЕЩАНИЕ[ \t]*:[ \t]*(.*)$/mu;

/**
 * Глаголы обязательства в первом лице: ответ модели, где агент берёт на
 * себя срок.
 *
 * Список намеренно узкий — только формы от первого лица («отправлю»,
 * «пришлём»). Пересказ условия из источника («лицензия предоставляется в
 * течение 120 минут»), повеление клиента («выдайте лицензию») и
 * безличные формулировки («отправка в течение трёх дней») обязательствами
 * агента не являются.
 */
const COMMITMENT_VERBS = [
  "отправлю",
  "отправим",
  "пришлю",
  "пришлём",
  "пришлем",
  "вышлю",
  "вышлем",
  "направлю",
  "направим",
  "доставлю",
  "доставим",
  "подготовлю",
  "подготовим",
  "оформлю",
  "оформим",
  "выдам",
  "выдадим",
  "выпущу",
  "выпустим",
  "поставлю",
  "поставим",
  "сделаю",
  "сделаем",
  "создам",
  "создадим",
  "верну",
  "вернём",
  "перезвоню",
  "свяжусь",
] as const;

/**
 * Глагол обязательства как регулярное выражение.
 *
 * Границы заданы явно через классы Unicode, а не через `\b`: в JavaScript
 * `\b` опирается на ASCII, и кириллица не считается символом слова — с
 * `\b` глагол «отправлю» в русском тексте не находился вовсе.
 */
const COMMITMENT_VERB_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${COMMITMENT_VERBS.join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

/**
 * Слова отрицания перед глаголом обязательства.
 *
 * «Без срока не отправлю КП» — оговорка, а не обещание: обязательства
 * из неё не возникает.
 */
const NEGATION_WORDS: Record<string, true> = {
  не: true,
  без: true,
  никогда: true,
};

/**
 * Вспомогательный глагол в отрицании: «не смогу отправить».
 *
 * Проверяется одно слово целиком, поэтому границы слова не нужны: `\b`
 * в JavaScript опирается на ASCII и по кириллице не срабатывает.
 */
const NEGATION_AUXILIARY =
  /^(?:смогу|сможем|сможет|буду|будем|будете|хотим|хочу|хочешь)$/u;

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
 * Та же грамматика срока, но с глобальным флагом: `matchAll` требует
 * глобальное выражение, иначе бросает `TypeError`.
 */
const DEADLINE_HINT_GLOBAL = new RegExp(DEADLINE_HINT.source, "giu");

/**
 * Граница предложения.
 *
 * Знак препинания не разделяет предложение, если с обеих сторон цифры:
 * иначе дата `12.03.2026` распалась бы на три обрывка и срок в
 * предложении не находился. Точка в конце даты (`12.03.2026.`) границей
 * остаётся: после неё цифры нет.
 */
const SENTENCE_BOUNDARY = /(?<!\d)[.;!?]+(?!\d)|\n/u;

/**
 * Все формулировки срока, названные в тексте.
 *
 * Текст обязательства уходит клиенту вместе с формулировкой модели (C18),
 * поэтому каждый названный в нём срок должен подтверждаться источником:
 * неподтверждённый срок в тексте обязательства — это обещание, которого
 * нет в источнике.
 */
function findDeadlinesInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DEADLINE_HINT_GLOBAL)) {
    const phrase = match[0].trim();
    if (phrase.length > 0) found.push(phrase);
  }
  return found;
}

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
 * Разбирает тело строки-маркера обязательства.
 *
 * Формат: `<текст> | срок: <формулировка> | источник: [N]`.
 * Неизвестные части игнорируются: обязательство не должно появляться из
 * текста, который ядро не понимает.
 */
function parseMarkerBody(body: string): PromiseMarker | null {
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
 * Разбирает строку-маркер обязательства.
 *
 * Маркер может стоять в любом месте строки: модель дописывает его в конец
 * абзаца, и такой ответ обязан быть виден ядру. Текст после маркера на той
 * же строке относится к маркеру.
 */
function parsePromiseMarker(line: string): PromiseMarker | null {
  const match = PROMISE_MARKER_LINE.exec(line);
  const body = match?.[1];
  if (body === undefined) return null;
  return parseMarkerBody(body);
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
 * Отрицается ли глагол обязательства в предложении.
 *
 * Отрицание ищется в нескольких словах перед глаголом внутри той же части
 * предложения: «не отправлю», «не смогу отправить», «без срока не
 * пришлю». Отрицание, отделённое запятой или точкой с запятой, к глаголу
 * не относится.
 */
function isNegated(sentence: string, verbIndex: number): boolean {
  const prefix = sentence.slice(0, verbIndex);
  // Последняя часть предложения перед глаголом: отрицание из предыдущей
  // части к глаголу не относится.
  const clause = prefix.slice(prefix.lastIndexOf(",") + 1);
  const words = clause.split(/\s+/u).filter((word) => word.length > 0);
  // Смотрим последние три слова перед глаголом: «не смогу отправить» —
  // отрицание через вспомогательный глагол.
  for (let depth = 1; depth <= 3 && depth <= words.length; depth += 1) {
    const word = words[words.length - depth];
    if (word === undefined) continue;
    const bare = word.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase();
    if (NEGATION_WORDS[bare] === true) return true;
    if (NEGATION_AUXILIARY.test(bare)) return true;
  }
  return false;
}

/**
 * Предложение текста ответа, в котором агент берёт на себя срок.
 *
 * Условия три, и все три обязательны:
 *
 * - глагол обязательства в первом лице («отправлю», «пришлём»): пересказ
 *   условия из источника и повеление клиента обязательством не являются;
 * - формулировка срока в том же предложении: обязательство без срока
 *   подтверждать нечем;
 * - нет отрицания перед глаголом: «без срока не отправлю КП» — оговорка,
 *   а не обещание.
 */
function findCommitmentSentence(text: string): string | null {
  for (const raw of text.split(SENTENCE_BOUNDARY)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (!DEADLINE_HINT.test(sentence)) continue;

    const verbMatch = COMMITMENT_VERB_PATTERN.exec(sentence);
    if (verbMatch === null) continue;
    if (isNegated(sentence, verbMatch.index)) continue;
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
 * Общий поиск для обоих случаев (B8): `marker` — оформленное обязательство,
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
 * Отдельная причина `promise_not_confirmed`: обязательство в ответе есть, а
 * подтверждения источником нет — из-за отсутствия строки-маркера. Ответ
 * модели без обязательства отказом не считается: возвращается `null`.
 *
 * `detail` описывает, что именно нашлось в тексте ответа, и уходит в
 * трассу и в очередь менеджеру — клиенту этот текст не показывается.
 */
export function unconfirmedCommitmentRejection(
  answerText: string,
  now: Date = new Date(),
): { reason: PromiseRejectionReason; detail: string } | null {
  const commitment = findUnmarkedCommitment(answerText, now);
  if (commitment === null) return null;

  return {
    reason: "promise_not_confirmed",
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
 *
 * Маркер распознаётся и тогда, когда стоит не в начале строки: текст перед
 * ним на той же строке клиенту остаётся, а маркер вместе со всем, что стоит
 * справа от него до конца строки, вырезается: «срок: … | источник: …»
 * клиенту не показывается.
 */
export function stripPromiseMarker(answerText: string, replacement = ""): string {
  let inserted = false;
  const stripped = answerText
    .replace(
      PROMISE_MARKER,
      (match: string, body: string, offset: number, whole: string) => {
        // Первое вхождение маркера заменяется текстом обязательства.
        if (!inserted && replacement.length > 0) {
          inserted = true;
          // Перенос строки перед маркером сохраняется: текст до маркера и
          // текст обязательства остаются разными абзацами.
          if (match.startsWith("\n")) return `\n${replacement}`;
          // Маркер в середине строки: перед ним есть свой текст, и без
          // переноса обязательство приклеилось бы к нему.
          const before = whole.slice(0, offset);
          const lineStart = before.lastIndexOf("\n") + 1;
          return before.slice(lineStart).trim().length > 0
            ? `\n${replacement}`
            : replacement;
        }
        // Остальные вхождения вырезаются целиком: два обязательства в одном
        // ответе клиенту не показываются.
        void body;
        return match.startsWith("\n") ? "\n" : "";
      },
    )
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
 * Формулировку задаёт модель, а не код: текст обещания сохраняет слова
 * модели, потому что именно они выражают намерение («пришлю расчёт и
 * коммерческое предложение»). Жёсткий шаблон («Счёт будет отправлен…»)
 * терял смысл обещания, и клиент получал не то, что агент пообещал (C18).
 *
 * Код добавляет к формулировке модели только то, что модель знать не могла:
 *
 * - подтверждённый срок (`до 12.03.2026`), если модель его не назвала;
 * - адресата в веб-канале (`на ⟦EMAIL_1⟧`), если модель его не назвала.
 *
 * Адрес — персональные данные: в текст попадает метка, а исходное
 * значение остаётся в таблице соответствий.
 *
 * Один и тот же текст уходит клиенту и попадает в журнал — менеджер видит
 * ровно то, что пообещали.
 */
export function promiseSentence(
  promise: Pick<
    ExtractedPromise,
    "text" | "channel" | "contactLabel" | "dueAt" | "deadlinePhrase"
  >,
): string {
  const due = formatDueDate(promise.dueAt);
  const phrase = promise.text.trim();

  // Срок добавляется, только если модель его не назвала: иначе клиент
  // получит «в течение 120 минут до 12.03.2026» — два срока в одной фразе.
  const mentionsDeadline =
    phrase.length > 0 &&
    containsPhrase(phrase, promise.deadlinePhrase);

  let sentence = phrase.length > 0 ? phrase : "Обязательство принято";

  if (promise.channel === "email") {
    const contact = promise.contactLabel;
    // Адресат добавляется, только если модель его не назвала: иначе метка
    // попадёт в текст дважды.
    if (contact !== null && !sentence.includes(contact)) {
      sentence = `${sentence} на ${contact}`;
    }
  }

  if (!mentionsDeadline) {
    sentence = `${sentence} до ${due}`;
  }

  return sentence;
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

  // Формулировка модели уходит клиенту вместе с подтверждённым сроком
  // (C18), поэтому каждый срок, названный в тексте обязательства, должен
  // подтверждаться тем же источником. Иначе модель дописала бы в
  // обязательство свой, неподтверждённый срок — и он ушёл бы клиенту.
  for (const mentioned of findDeadlinesInText(candidate.text)) {
    if (!containsPhrase(source.text, mentioned)) {
      return rejected(
        "deadline_not_in_source",
        `Срок «${mentioned}» из текста обязательства не встречается в тексте подтверждённого источника.`,
      );
    }
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
