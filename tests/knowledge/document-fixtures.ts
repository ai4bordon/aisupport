/**
 * Синтетические материалы для тестов среза 03.
 *
 * Документы собираются в памяти: PDF — через pdfkit (тот же инструмент, что и
 * в модуле документов), DOCX — минимальным ZIP-контейнером с
 * `word/document.xml`. Реальных персональных данных в текстах нет.
 *
 * Тексты длиннее 800 знаков: чанк такого размера цитируем, а материал без
 * цитируемого чанка в базе знаний не нужен.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import PDFDocument from "pdfkit";
import { deflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);

/**
 * Собирает PDF с заданным текстом.
 *
 * @param text текст документа.
 */
export async function buildPdf(text: string): Promise<Buffer> {
  const document = new PDFDocument();
  const parts: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (part: Buffer) => parts.push(part));
    document.on("end", () => resolve(Buffer.concat(parts)));
    document.on("error", reject);
  });

  // Шрифт подаётся буфером, а не путём: pdfkit отличает шрифт по
  // `instanceof Uint8Array`, а в окружении jsdom конструктор из другой
  // области видимости, и проверка не проходит.
  //
  // Начертания подключаются по двум сабсетам: кириллица лежит в подмножестве
  // `cyrillic`, а цифры и латиница — в `latin`. Набор по одному сабсету не
  // покрывает документ целиком: цифры в кириллическом подмножестве
  // заменяются глифом `.notdef` и в текст не попадают.
  document.registerFont("cyrillic", await readFile(fontFile("cyrillic")));
  document.registerFont("latin", await readFile(fontFile("latin")));
  document.font("cyrillic");
  document.fontSize(12);
  const runs = splitBySubset(text);
  for (const [index, run] of runs.entries()) {
    document.font(run.latin ? "latin" : "cyrillic");
    // Фрагменты идут в одну строку: перенос посреди предложения разорвал бы
    // его на части, а извлечённый текст должен читаться как оригинал.
    document.text(run.text, undefined, undefined, { continued: index < runs.length - 1 });
  }
  document.end();

  return finished;
}

/** Файл начертания Montserrat из пакета `@fontsource/montserrat`. */
function fontFile(subset: "cyrillic" | "latin"): string {
  const root = dirname(require.resolve("@fontsource/montserrat/package.json"));
  return join(root, "files", `montserrat-${subset}-400-normal.woff`);
}

/**
 * Фрагменты текста по сабсетам шрифта.
 *
 * Кириллица набирается начертанием с кириллическим подмножеством, остальное —
 * латинским. Начертание переключается только на границе подмножеств: внутри
 * слова переключение разорвало бы начертание посередине.
 */
function splitBySubset(text: string): Array<{ text: string; latin: boolean }> {
  const runs: Array<{ text: string; latin: boolean }> = [];
  for (const part of text.split(/(\p{Script=Cyrillic}+)/u)) {
    if (part.length === 0) continue;
    const latin = !/\p{Script=Cyrillic}/u.test(part);
    const previous = runs[runs.length - 1];
    if (previous && previous.latin === latin) {
      previous.text += part;
      continue;
    }
    runs.push({ text: part, latin });
  }
  return runs;
}

/** CRC-32 для заголовков ZIP: без него распаковщик отвергнет контейнер. */
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

/**
 * Собирает ZIP-контейнер из имён файлов и их содержимого.
 *
 * Записи сжимаются методом deflate, порядок сохраняется: так контейнер
 * выглядит как настоящий офисный документ, а не как набор случайных байтов.
 *
 * @param entries имя файла → содержимое.
 */
export function buildZip(entries: Array<[string, string]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const contentBytes = Buffer.from(content, "utf8");
    const compressed = deflateRawSync(contentBytes);
    const checksum = crc32(contentBytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contentBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contentBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * Собирает DOCX с заданными абзацами.
 *
 * @param paragraphs абзацы документа.
 */
export function buildDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map(
      (paragraph) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`,
    )
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;

  return buildZip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["word/document.xml", document],
  ]);
}

/** Экранирование текста для XML: спецсимволы в тексте документа недопустимы. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
