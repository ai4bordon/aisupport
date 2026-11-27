import { inflateRawSync, inflateSync } from "node:zlib";

import { KnowledgeDocumentError } from "./errors";
import type { ParsedDocument, SupportedDocumentFormat } from "./types";

/**
 * Разбор загруженного файла.
 *
 * Это разбор файла, а не серверного HTML: `src/import/knowledge/extract.ts`
 * работает с разметкой страниц сайта и для бинарных форматов не подходит.
 *
 * Формат определяется по расширению **и** по сигнатуре содержимого. Одного
 * признака недостаточно: переименованный `installer.exe` с корректным
 * содержимым PDF не должен разбираться как документ, а файл `report.pdf` с
 * текстом внутри — не должен приниматься за PDF.
 */

/** Поддерживаемые форматы в сообщении об отказе. */
export const SUPPORTED_FORMATS_LABEL = "PDF, DOCX, Markdown, TXT";

/** Расширения, сопоставленные с форматами. */
const EXTENSION_FORMATS: Record<string, SupportedDocumentFormat> = {
  pdf: "pdf",
  docx: "docx",
  md: "md",
  markdown: "md",
  txt: "txt",
};

/** MIME-типы форматов: используются для поля `mime_type` документа. */
const FORMAT_MIME_TYPES: Record<SupportedDocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
};

/** Расширение файла в нижнем регистре, без точки. */
function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/u).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Формат по расширению или `null`, если расширение не поддерживается. */
export function formatFromFilename(filename: string): SupportedDocumentFormat | null {
  const extension = extensionOf(filename);
  if (extension.length === 0) return null;
  return EXTENSION_FORMATS[extension] ?? null;
}

/** MIME-тип формата. */
export function mimeTypeFor(format: SupportedDocumentFormat): string {
  return FORMAT_MIME_TYPES[format];
}

/** ZIP-сигнатура: `PK\x03\x04`. */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** PDF-сигнатура: `%PDF-`. */
const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");

/**
 * DOCX — это ZIP-контейнер с основной частью `word/document.xml`.
 *
 * Одной ZIP-сигнатуры мало: обычный архив с тем же расширением не является
 * документом Word, и разбирать его как документ бессмысленно.
 */
function isDocxContainer(bytes: Buffer): boolean {
  try {
    return readZipEntries(bytes).some((entry) => entry.name === "word/document.xml");
  } catch {
    return false;
  }
}

/**
 * Формат по сигнатуре содержимого или `null`, если сигнатура не опознана.
 *
 * Текстовые форматы (Markdown, TXT) сигнатуры не имеют: ими считается любой
 * файл без бинарных маркеров, который декодируется как UTF-8. Различие между
 * Markdown и TXT делается по расширению: оба формата — текст, и их текст
 * разбирается одинаково.
 */
export function formatFromContent(bytes: Buffer): SupportedDocumentFormat | null {
  if (bytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) return "pdf";
  if (bytes.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
    return isDocxContainer(bytes) ? "docx" : null;
  }
  if (looksLikeText(bytes)) return "txt";
  return null;
}

/**
 * Текстовый файл: в содержимом нет нулевых байтов и нет управляющих символов
 * вне ASCII-диапазона.
 */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return false;
    // Управляющие символы, кроме переводов строк, табуляции и возврата
    // каретки, в текстовом файле не встречаются.
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

/**
 * Определяет формат файла по расширению и сигнатуре.
 *
 * @param filename имя файла как его прислал менеджер.
 * @param bytes содержимое файла.
 */
export function detectFormat(filename: string, bytes: Buffer): SupportedDocumentFormat {
  const byName = formatFromFilename(filename);
  if (byName === null) {
    throw new KnowledgeDocumentError(
      "unsupported_media_type",
      "file",
      `Формат файла «${filename}» не поддерживается. Поддерживаются: ${SUPPORTED_FORMATS_LABEL}.`,
    );
  }

  const byContent = formatFromContent(bytes);
  if (byContent === null || !formatsMatch(byName, byContent)) {
    throw new KnowledgeDocumentError(
      "unsupported_media_type",
      "file",
      `Содержимое файла «${filename}» не соответствует расширению. Поддерживаются: ${SUPPORTED_FORMATS_LABEL}.`,
    );
  }

  return byName;
}

/**
 * Совпадают ли формат по расширению и формат по сигнатуре.
 *
 * Markdown и TXT разбираются одинаково, поэтому текстовый сигнатурный формат
 * подходит обоим. DOCX опознаётся по ZIP-контейнеру с основной частью
 * `word/document.xml`: обычный архив под расширением `.docx` документом
 * Word не является.
 */
function formatsMatch(
  byName: SupportedDocumentFormat,
  byContent: SupportedDocumentFormat,
): boolean {
  if (byName === byContent) return true;
  return (byName === "md" || byName === "txt") && byContent === "txt";
}

/**
 * Разбирает загруженный файл в текст.
 *
 * @param bytes содержимое файла.
 * @param format формат, подтверждённый расширением и сигнатурой.
 */
export function parseDocument(
  bytes: Buffer,
  format: SupportedDocumentFormat,
): ParsedDocument {
  switch (format) {
    case "pdf":
      return { format, text: extractPdfText(bytes), pages: countPdfPages(bytes) };
    case "docx":
      return { format, text: extractDocxText(bytes), pages: 1 };
    case "md":
    case "txt":
      return { format, text: extractPlainText(bytes), pages: 1 };
  }
}

/**
 * Текстовый файл: UTF-8 с нормализацией переводов строк.
 */
function extractPlainText(bytes: Buffer): string {
  const text = bytes.toString("utf8").replace(/\r\n?/gu, "\n");
  return text.trim();
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * Запись ZIP-контейнера.
 */
type ZipEntry = {
  name: string;
  data: Buffer;
};

/**
 * Читает записи ZIP-контейнера.
 *
 * Сжатие — deflate (`inflateRawSync`), как его пишут офисные пакеты. Метод
 * хранителя тоже поддерживается: часть инструментов собирает документы без
 * сжатия.
 *
 * @param bytes контейнер.
 */
function readZipEntries(bytes: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) break;

    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const payload = bytes.subarray(dataStart, dataEnd);

    if (method === 0) {
      entries.push({ name, data: Buffer.from(payload) });
    } else if (method === 8) {
      entries.push({ name, data: inflateRawSync(payload) });
    } else {
      throw new KnowledgeDocumentError(
        "parse_failed",
        "file",
        `Сжатие «${name}» в документе Word не поддерживается.`,
      );
    }

    offset = dataEnd;
  }

  return entries;
}

/**
 * Текст документа Word: абзацы из `word/document.xml`.
 *
 * XML разбирается регулярной разметкой, а не внешним парсером: в офисном
 * документе достаточно собрать текст узлов `w:t` и разбить его по абзацам
 * `w:p`.
 */
function extractDocxText(bytes: Buffer): string {
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(bytes);
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) throw error;
    throw new KnowledgeDocumentError(
      "parse_failed",
      "file",
      "Не удалось прочитать контейнер документа Word.",
    );
  }

  const document = entries.find((entry) => entry.name === "word/document.xml");
  if (document === undefined) {
    throw new KnowledgeDocumentError(
      "parse_failed",
      "file",
      "В документе Word нет основной части word/document.xml.",
    );
  }

  const xml = document.data.toString("utf8");
  const paragraphs: string[] = [];

  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)) {
    const body = match[1] ?? "";
    const pieces: string[] = [];
    for (const textMatch of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)) {
      pieces.push(decodeXmlEntities(textMatch[1] ?? ""));
    }
    const paragraph = pieces.join("").trim();
    if (paragraph.length > 0) paragraphs.push(paragraph);
  }

  if (paragraphs.length === 0) {
    throw new KnowledgeDocumentError(
      "parse_failed",
      "file",
      "В документе Word нет текста.",
    );
  }

  return paragraphs.join("\n");
}

/** Раскодирование сущностей XML: `&amp;` → `&`, `&#65;` → `A`. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_all, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Объект PDF: словарь и поток данных.
 */
type PdfObject = {
  id: number;
  dict: string;
  stream: Buffer | null;
};

/**
 * Разбор объектов PDF.
 *
 * Объекты читаются последовательно: словарь — до маркера потока, поток — по
 * `/Length`. Поиск конца словаря по первому `>>` не годится: вложенные
 * словари (`/W [...]`) сбивают границы объектов.
 */
function parsePdfObjects(raw: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const text = raw.toString("latin1");
  const header = /(\d+)\s+0\s+obj/g;
  let position = 0;

  for (;;) {
    header.lastIndex = position;
    const match = header.exec(text);
    if (!match) break;
    const id = Number(match[1]);
    const bodyStart = match.index + match[0].length;

    const streamMarker = text.indexOf("\nstream", bodyStart);
    const endObj = text.indexOf("endobj", bodyStart);
    if (streamMarker < 0 || (endObj >= 0 && endObj < streamMarker)) {
      objects.set(id, {
        id,
        dict: text.slice(bodyStart, endObj < 0 ? text.length : endObj),
        stream: null,
      });
      position = endObj < 0 ? text.length : endObj + 6;
      continue;
    }

    const dict = text.slice(bodyStart, streamMarker);
    const length = Number(/\/Length\s+(\d+)/u.exec(dict)?.[1] ?? "0");
    let streamStart = streamMarker + "\nstream".length;
    if (text[streamStart] === "\r") streamStart += 1;
    if (text[streamStart] === "\n") streamStart += 1;
    const end = streamStart + length;
    objects.set(id, {
      id,
      dict,
      stream: raw.subarray(streamStart, Math.min(end, raw.length)),
    });

    const endStream = text.indexOf("endstream", end);
    position = endStream < 0 ? end : endStream + 9;
  }

  return objects;
}

/**
 * Карта символов `ToUnicode`: код глифа → символ.
 */
type CMap = Map<number, string>;

/**
 * Раскодирование последовательности UTF-16BE из карты `ToUnicode`.
 *
 * Код `0000` пропускается: это глиф `.notdef`, которым шрифт помечает
 * символ, не имеющий изображения. В тексте он не значит ничего, а нулевой байт
 * в строке база данных не принимает.
 */
function decodeCMapEntry(hex: string): string {
  let out = "";
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    const code = Number.parseInt(hex.slice(index, index + 4), 16);
    if (Number.isNaN(code) || code === 0) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Разбор карты `ToUnicode`: блоки `bfchar` и `bfrange`.
 */
function decodeCMap(cmap: string): CMap {
  const map: CMap = new Map();

  const charBlock = /beginbfchar([\s\S]*?)endbfchar/gu;
  let block: RegExpExecArray | null;
  while ((block = charBlock.exec(cmap)) !== null) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu;
    let entry: RegExpExecArray | null;
    while ((entry = pair.exec(block[1] ?? "")) !== null) {
      map.set(Number.parseInt(entry[1] as string, 16), decodeCMapEntry(entry[2] as string));
    }
  }

  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/gu;
  while ((block = rangeBlock.exec(cmap)) !== null) {
    const range =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/gu;
    let entry: RegExpExecArray | null;
    while ((entry = range.exec(block[1] ?? "")) !== null) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Number.parseInt(entry[2] as string, 16);
      if (entry[3] !== undefined) {
        const start = Number.parseInt(entry[3] as string, 16);
        for (let code = low; code <= high; code += 1) {
          const mapped = start + (code - low);
          if (mapped === 0) continue;
          map.set(code, String.fromCharCode(mapped));
        }
        continue;
      }
      const items = [...(entry[4] ?? "").matchAll(/<([0-9A-Fa-f]+)>/gu)];
      items.forEach((item, index) => {
        map.set(low + index, decodeCMapEntry(item[1] as string));
      });
    }
  }

  return map;
}

/**
 * Содержимое потока: распаковывается, если поток сжат.
 */
function decodeStream(stream: Buffer): string {
  try {
    return inflateSync(stream).toString("latin1");
  } catch {
    return stream.toString("latin1");
  }
}

/**
 * Ссылка на объект по имени ресурса шрифта.
 */
function fontObjectByResource(objects: Map<number, PdfObject>): Map<string, number> {
  const map = new Map<string, number>();
  for (const object of objects.values()) {
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/u.exec(object.dict);
    if (!fontBlock) continue;
    for (const entry of (fontBlock[1] ?? "").matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/gu)) {
      map.set(entry[1] as string, Number(entry[2]));
    }
  }
  return map;
}

/**
 * Текстовый фрагмент содержимого страницы: позиция и коды глифов.
 */
type PdfTextRun = {
  resourceName: string;
  x: number;
  y: number;
  codes: string;
};

/**
 * Сбор текстовых фрагментов из содержимого страницы.
 */
function collectPdfTextRuns(content: string): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  const block = /BT([\s\S]*?)ET/gu;
  let match: RegExpExecArray | null;

  while ((match = block.exec(content)) !== null) {
    const body = match[1] ?? "";
    const resourceName = /\/(\w+)\s+[\d.]+\s+Tf/u.exec(body)?.[1] ?? "";
    const position = /1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/u.exec(body);
    const codes: string[] = [];

    // Шестнадцатеричные строки и обычные строки в скобках.
    const token = /<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/gu;
    let item: RegExpExecArray | null;
    while ((item = token.exec(body)) !== null) {
      if (item[1] !== undefined) {
        codes.push(item[1]);
        continue;
      }
      const literal = item[2] ?? "";
      const decoded = literal
        .replace(/\\n/gu, "\n")
        .replace(/\\r/gu, "\r")
        .replace(/\\t/gu, "\t")
        .replace(/\\([()\\])/gu, "$1")
        .replace(/\\([0-7]{1,3})/gu, (_all, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        );
      codes.push(
        [...decoded]
          .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
          .join(""),
      );
    }

    if (codes.length > 0) {
      runs.push({
        resourceName,
        x: position ? Number(position[1]) : Number.NaN,
        y: position ? Number(position[2]) : Number.NaN,
        codes: codes.join(""),
      });
    }
  }

  return runs;
}

/**
 * Текст PDF.
 *
 * Разбор собственный и минимальный: потоки страниц и карты `ToUnicode`.
 * Внешняя зависимость ради чтения текста из чужого файла не нужна, а лишняя
 * библиотека в срезе — лишний риск.
 */
export function extractPdfText(raw: Buffer): string {
  const objects = parsePdfObjects(raw);
  const cmapByFont = new Map<number, CMap>();

  for (const object of objects.values()) {
    if (!/\/Subtype\s*\/Type0/u.test(object.dict)) continue;
    const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+0\s+R/u.exec(object.dict)?.[1];
    if (toUnicodeRef === undefined) continue;
    const cmapObject = objects.get(Number(toUnicodeRef));
    if (!cmapObject?.stream) continue;
    cmapByFont.set(object.id, decodeCMap(decodeStream(cmapObject.stream)));
  }

  const fonts = fontObjectByResource(objects);
  const pieces: string[] = [];
  let lastY: number | null = null;

  for (const object of objects.values()) {
    if (!object.stream) continue;
    const content = decodeStream(object.stream);
    if (!/(Tj|TJ)/u.test(content)) continue;

    for (const run of collectPdfTextRuns(content)) {
      const fontObject = fonts.get(run.resourceName);
      const cmap = fontObject === undefined ? undefined : cmapByFont.get(fontObject);

      let decoded = "";
      for (let index = 0; index + 4 <= run.codes.length; index += 4) {
        const code = Number.parseInt(run.codes.slice(index, index + 4), 16);
        if (Number.isNaN(code)) continue;
        // Без карты `ToUnicode` код не восстановить: символ не угадать.
        decoded += cmap?.get(code) ?? "";
      }
      if (decoded.length === 0) continue;

      // Новая строка начинается, когда текст переехал на другую высоту.
      if (lastY !== null && Number.isFinite(run.y) && Math.abs(run.y - lastY) > 0.5) {
        pieces.push("\n");
      }
      pieces.push(decoded);
      if (Number.isFinite(run.y)) lastY = run.y;
    }
  }

  const text = pieces.join("");
  // Служебные коды без изображения (`.notdef`) и нулевые байты в тексте
  // ничего не значат: в базу такая строка не пишется, а читателю они не
  // нужны. Пробелы при этом сохраняются — они разделяют слова.
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
    .trim();
  if (cleaned.length === 0) {
    throw new KnowledgeDocumentError(
      "parse_failed",
      "file",
      "В PDF не найден текст: документ отсканирован или использует неподдерживаемое кодирование.",
    );
  }
  return text.trim();
}

/** Число страниц PDF: страницы дерева `/Type /Pages` и `/Type /Page`. */
function countPdfPages(raw: Buffer): number {
  const objects = parsePdfObjects(raw);
  let pages = 0;
  for (const object of objects.values()) {
    if (/\/Type\s*\/Page(?:\s|\/|>>)/u.test(object.dict)) pages += 1;
  }
  return Math.max(pages, 1);
}
