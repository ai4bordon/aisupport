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
 * Раскладывает предложения по чанкам так, чтобы размеры были ровными.
 *
 * Число чанков считается от объёма текста и ограничено снизу: каждый чанк
 * должен вмещать минимум. Границы ставятся по пропорциональным позициям
 * в тексте и округляются до ближайшей границы предложения, поэтому размеры
 * чанков близки, а последний не остаётся коротким.
 */
function splitEvenly(
  sentences: string[],
  minBody: number,
  maxBody: number,
  targetBody: number,
): string[] {
  if (sentences.length === 0) return [];

  const count = sentences.length;
  const prefix: number[] = [0];
  for (const sentence of sentences) {
    prefix.push((prefix[prefix.length - 1] ?? 0) + sentence.length);
  }
  const total = prefix[count] ?? 0;

  const byTarget = Math.ceil(total / targetBody);
  // Больше чанков брать нельзя: тогда каждый окажется короче минимума.
  const byMinimum = Math.max(1, Math.floor(total / minBody));
  const chunkCount = Math.max(1, Math.min(byTarget, byMinimum, count));

  // Длина чанка из предложений с индексами от first до last включительно.
  const lengthOf = (first: number, last: number): number =>
    (prefix[last + 1] ?? 0) - (prefix[first] ?? 0) + (last - first);

  const boundaries: number[] = [];
  let start = 0;
  for (let chunk = 1; chunk < chunkCount; chunk += 1) {
    const desired = (chunk / chunkCount) * total;
    const remainingChunks = chunkCount - chunk;

    // Ищем границу, ближайшую к желаемой позиции, с допустимой длиной.
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let last = start; last < count; last += 1) {
      const length = lengthOf(start, last);
      if (length > maxBody) break;
      if (length < minBody) continue;
      // После границы должно хватить текста на остальные чанки.
      const rest = (prefix[count] ?? 0) - (prefix[last + 1] ?? 0) + (count - last - 1);
      if (rest < remainingChunks * minBody) continue;

      const distance = Math.abs((prefix[last + 1] ?? 0) - desired);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = last;
      }
    }

    if (best === -1) {
      // Подходящей границы нет — chunk забирает максимум возможного.
      let last = start;
      while (last + 1 < count && lengthOf(start, last + 1) <= maxBody) last += 1;
      boundaries.push(last);
      start = last + 1;
      continue;
    }

    boundaries.push(best);
    start = best + 1;
  }

  const groups: string[] = [];
  let first = 0;
  for (const boundary of boundaries) {
    groups.push(sentences.slice(first, boundary + 1).join(" "));
    first = boundary + 1;
  }
  groups.push(sentences.slice(first).join(" "));

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
