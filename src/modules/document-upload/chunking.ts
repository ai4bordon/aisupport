import { chunkSource, type Chunk, type SourceContent } from "@/import/knowledge";

/**
 * Адаптация разобранного документа к существующей нарезке.
 *
 * Нарезка не переписывается: чанки документа делаются тем же кодом, что и
 * импорт с сайта (`chunkSource`), поэтому размер чанка, шапка источника и
 * формат цитаты совпадают у обоих потоков. Вторая реализация нарезки в
 * срезе завела бы два формата цитаты.
 */

/** Разобранный документ, готовый к нарезке. */
export type ChunkableDocument = {
  /** Имя файла документа: на него ссылается шапка чанка. */
  filename: string;
  /** Извлечённый текст. */
  text: string;
  /** Время загрузки документа. */
  uploadedAt: string;
};

/**
 * Ссылка на загруженный документ в шапке чанка.
 *
 * Это имя файла в кабинете менеджера, а не URL: клиентский адрес у материала
 * нет, а выдуманная ссылка в цитате была бы враньём. Имя файла очищается от
 * символов, из которых можно собрать ссылку.
 */
export function sourceReference(filename: string): string {
  const base = filename.split(/[\\/]/u).pop() ?? filename;
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/:\/\//gu, "_")
    .trim();
  return cleaned.length > 0 ? cleaned : "документ";
}

/**
 * Собирает содержимое источника для нарезки.
 *
 * @param document разобранный документ.
 */
export function toSourceContent(document: ChunkableDocument): SourceContent {
  return {
    url: sourceReference(document.filename),
    title: document.filename,
    sectionPath: "",
    text: document.text,
    crawledAt: document.uploadedAt,
  };
}

/**
 * Нарезает документ на цитируемые чанки.
 *
 * @param document разобранный документ.
 */
export function chunkDocument(document: ChunkableDocument): Chunk[] {
  return chunkSource(toSourceContent(document));
}
