/**
 * Нарезка текста источника на цитируемые чанки.
 *
 * Правила (контракт §8.2):
 * - размер чанка 800–1200 знаков, цель — 1000;
 * - в каждом чанке сохраняются заголовок, путь разделов и URL источника;
 * - границы ставятся по границам предложений, если предложение помещается.
 *
 * URL и путь разделов кладутся в первую строку текста чанка (`Источник: …`):
 * в замороженной модели данных у `kb_chunks` нет отдельных колонок под
 * ссылку, а цитата строится из текста найденного чанка.
 */

import { createHash } from "node:crypto";

export type SourceContent = {
  url: string;
  title: string;
  sectionPath: string;
  text: string;
  crawledAt: string;
};

export type Chunk = {
  articleId: string;
  chunkNo: number;
  totalChunks: number;
  title: string;
  sectionPath: string;
  sourceUrl: string;
  text: string;
};

const MIN_CHUNK_LENGTH = 800;
const MAX_CHUNK_LENGTH = 1200;
const TARGET_CHUNK_LENGTH = 1000;

/**
 * Минимальный размер текста, ради которого материал попадает в индекс.
 *
 * Чанк короче минимального размера цитировать нечем: в нём не помещается
 * содержательное утверждение. Но отбрасывать весь материал из-за одного
 * короткого чанка нельзя: статья, чей текст короче минимального чанка,
 * остаётся опубликованной и в поиск не попадает вовсе. Например, статья
 * «Оплата подписки» объёмом 161 знак осталась без чанков, и вопрос про
 * оплату подписки уходил в эскалацию.
 *
 * Поэтому материал с текстом попадает в индекс хотя бы одним чанком:
 * длинный материал режется как обычно, короткий — сохраняется целиком.
 */
const MIN_INDEXABLE_BODY_LENGTH = 40;

/**
 * Отбор чанков материала для индексации.
 *
 * Правило:
 * - материал длиннее минимального чанка индексируется целиком, все его
 *   чанки пригодны;
 * - материал короче — индексируется, если в нём есть содержательный текст;
 *   чанк при этом может быть короче минимального размера, но текст в нём
 *   есть;
 * - материал без содержательного текста (страница-оглавление, пустая
 *   выжимка) в индекс не попадает: цитировать нечего.
 */
export function selectIndexableChunks(chunks: Chunk[]): Chunk[] {
  if (chunks.length === 0) return [];
  const longEnough = chunks.filter((chunk) => chunk.text.length >= MIN_CHUNK_LENGTH);
  if (longEnough.length > 0) return longEnough;
  // Короткий материал: берём те чанки, где под шапкой есть текст.
  const withBody = chunks.filter((chunk) => {
    const body = chunk.text.split("\n").slice(1).join("\n").trim();
    return body.length >= MIN_INDEXABLE_BODY_LENGTH;
  });
  return withBody.length > 0 ? withBody : [];
}

/**
 * Идентификатор источника: детерминированный UUID по URL.
 *
 * Один и тот же URL всегда даёт один и тот же идентификатор — повторный
 * импорт обновляет тот же источник, а не плодит дубли.
 */
export function sourceId(url: string): string {
  const digest = createHash("sha256").update(url).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Версия 5 и вариант RFC 4122 — как у UUIDv5, но без внешней библиотеки.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Делит текст на предложения, сохраняя завершающий знак. */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const pattern = /[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const sentence = match[0].trim();
    if (sentence.length > 0) sentences.push(sentence);
    match = pattern.exec(text);
  }
  return sentences;
}

/** Режет слишком длинное предложение по словам, не разрывая слово. */
function splitLongSentence(sentence: string, maxLength: number): string[] {
  if (sentence.length <= maxLength) return [sentence];

  const words = sentence.split(/\s+/);
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxLength && current.length > 0) {
      parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Шапка чанка: URL источника, путь разделов и заголовок. */
function buildHeader(source: SourceContent): string {
  const path = source.sectionPath.trim();
  const title = source.title.trim();
  const firstLine = path.length > 0 ? `Источник: ${source.url} | ${path}` : `Источник: ${source.url}`;
  return title.length > 0 ? `${firstLine}\n${title}` : firstLine;
}

/**
 * Нарезает источник на чанки.
 *
 * @param source содержимое источника: URL, заголовок, путь разделов, текст.
 */
export function chunkSource(source: SourceContent): Chunk[] {
  const header = buildHeader(source);
  // Шапка — часть текста чанка, поэтому её длина вычитается из бюджета.
  const headerLength = header.length + 1;
  const maxBody = Math.max(1, MAX_CHUNK_LENGTH - headerLength);
  const minBody = Math.max(1, MIN_CHUNK_LENGTH - headerLength);
  const targetBody = Math.min(maxBody, Math.max(minBody, TARGET_CHUNK_LENGTH - headerLength));

  const sentences = splitSentences(source.text).flatMap((sentence) =>
    splitLongSentence(sentence, maxBody),
  );

  const groups = splitEvenly(sentences, minBody, maxBody, targetBody);

  const articleId = sourceId(source.url);
  const totalChunks = groups.length;
  return groups.map((body, index) => ({
    articleId,
    chunkNo: index,
    totalChunks,
    title: source.title,
    sectionPath: source.sectionPath,
    sourceUrl: source.url,
    text: `${header}\n${body}`,
  }));
}

/**
 * Раскладывает предложения по чанкам.
 *
 * Жёсткое ограничение — максимум: чанк никогда не превышает `maxBody`.
 * Мягкое — доля: чанк закрывается, когда набрана своя часть текста, если
 * остатка хватает на остальные чанки по минимуму. Границы остаются на
 * границах предложений.
 */
function splitEvenly(
  sentences: string[],
  minBody: number,
  maxBody: number,
  targetBody: number,
): string[] {
  if (sentences.length === 0) return [];

  const count = sentences.length;
  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0);

  // Столько чанков нужно, чтобы уложиться в целевой размер...
  const byTarget = Math.ceil(total / targetBody);
  // ...и столько — чтобы каждый не опустился ниже минимума.
  const byMinimum = Math.max(1, Math.floor(total / minBody));
  const chunkCount = Math.max(1, Math.min(byTarget, byMinimum, count));

  const groups: string[] = [];
  let index = 0;
  let chunk = 0;

  // Цикл идёт, пока текст не закончился: плановое число чанков задаёт долю,
  // но если текст в неё не уложился, добавляются дополнительные чанки.
  while (index < count) {
    const isLastPlanned = chunk >= chunkCount - 1;
    // Бюджет чанка — своя доля текста; за её пределами берём максимум.
    const budget = isLastPlanned ? Number.POSITIVE_INFINITY : ((chunk + 1) / chunkCount) * total;
    const group: string[] = [];
    let length = 0;

    while (index < count) {
      const sentence = sentences[index];
      if (sentence === undefined) break;
      const addition = group.length === 0 ? sentence.length : sentence.length + 1;

      if (group.length > 0 && length + addition > maxBody) break;
      // Бюджет достигнут — чанк закрываем, если дальше есть ещё предложения.
      if (group.length > 0 && length >= budget && !isLastPlanned) break;

      group.push(sentence);
      length += addition;
      index += 1;
    }

    if (group.length > 0) groups.push(group.join(" "));
    chunk += 1;
  }

  balanceGroups(groups, minBody, maxBody);
  return groups;
}

/**
 * Подгоняет размеры: чанк короче минимума добирает предложения у соседа
 * слева, если сосед от этого не опускается ниже минимума. Границы
 * предложений при этом не рвутся.
 */
function balanceGroups(groups: string[], minBody: number, maxBody: number): void {
  for (let index = 1; index < groups.length; index += 1) {
    const current = groups[index];
    if (current === undefined || current.length >= minBody) continue;

    const previous = groups[index - 1];
    if (previous === undefined) continue;

    const previousSentences = splitSentences(previous);
    if (previousSentences.length < 2) continue;

    // Переносим предложения из соседа по одному, пока оба не станут длиннее
    // минимума: границы предложений при этом не рвутся.
    for (let taken = 0; taken < previousSentences.length - 1; taken += 1) {
      const moved = previousSentences[previousSentences.length - 1 - taken];
      const rest = previousSentences.slice(0, previousSentences.length - 1 - taken).join(" ");
      if (moved === undefined || rest.length < minBody) break;
      const grown = `${moved} ${current}`;
      if (grown.length > maxBody) break;
      groups[index - 1] = rest;
      groups[index] = grown;
      if (grown.length >= minBody) break;
    }
  }
}
