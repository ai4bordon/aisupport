/**
 * Инструмент тестов среза «документы»: разбор собранного PDF.
 *
 * Проверки полей КП и счёта идут по самому документу, а не по внутренним
 * структурам модуля: из PDF извлекаются текст, шрифты, залитые цвета и
 * внедрённые изображения.
 */

import zlib from "node:zlib";

type PdfObject = {
  id: number;
  dict: string;
  stream: Buffer | null;
};

/**
 * Разбор объектов PDF. Объекты читаются последовательно: словарь — до
 * маркера потока, поток — по `/Length`. Поиск конца словаря по первому `>>`
 * не годится: вложенные словари (`/W [...]`) сбивают границы объектов.
 */
function parseObjects(raw: Buffer): Map<number, PdfObject> {
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
    const length = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? "0");
    let streamStart = streamMarker + "\nstream".length;
    if (text[streamStart] === "\r") streamStart += 1;
    if (text[streamStart] === "\n") streamStart += 1;
    const end = streamStart + length;
    objects.set(id, { id, dict, stream: raw.subarray(streamStart, Math.min(end, raw.length)) });

    const endStream = text.indexOf("endstream", end);
    position = endStream < 0 ? end : endStream + 9;
  }
  return objects;
}

function decodeCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToString = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      const code = Number.parseInt(hex.slice(i, i + 4), 16);
      if (Number.isNaN(code)) continue;
      out += String.fromCharCode(code);
    }
    return out;
  };
  const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  let block: RegExpExecArray | null;
  while ((block = charBlock.exec(cmap)) !== null) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let entry: RegExpExecArray | null;
    while ((entry = pair.exec(block[1] as string)) !== null) {
      map.set(Number.parseInt(entry[1] as string, 16), hexToString(entry[2] as string));
    }
  }
  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlock.exec(cmap)) !== null) {
    const range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let entry: RegExpExecArray | null;
    while ((entry = range.exec(block[1] as string)) !== null) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Number.parseInt(entry[2] as string, 16);
      if (entry[3] !== undefined) {
        const start = Number.parseInt(entry[3], 16);
        for (let code = low; code <= high; code += 1) {
          map.set(code, String.fromCharCode(start + (code - low)));
        }
      } else {
        const items = [...(entry[4] ?? "").matchAll(/<([0-9A-Fa-f]+)>/g)];
        items.forEach((item, index) => {
          map.set(low + index, hexToString(item[1] as string));
        });
      }
    }
  }
  return map;
}

export type PdfFont = { resourceName: string; baseFont: string };

export type PdfImage = { width: number; height: number };

/** Размещение изображения на странице: масштаб по X и Y и позиция. */
export type PdfImagePlacement = {
  name: string;
  scaleX: number;
  scaleY: number;
  x: number;
  y: number;
};

export type PdfColor = { r: number; g: number; b: number };

/** Текстовый фрагмент с цветом заливки, которым он напечатан. */
export type PdfTextRun = {
  resourceName: string;
  text: string;
  color: PdfColor | null;
  x: number;
  y: number;
};

export type ParsedPdf = {
  text: string;
  fonts: PdfFont[];
  images: PdfImage[];
  placements: PdfImagePlacement[];
  colors: PdfColor[];
  runs: PdfTextRun[];
  pageWidth: number;
  pageHeight: number;
};

type TextRun = { resourceName: string; y: number; x: number; codes: string };

function collectTextRuns(content: string): TextRun[] {
  const runs: TextRun[] = [];
  const block = /BT([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(content)) !== null) {
    const body = match[1] as string;
    const resourceName = /\/(\w+)\s+[\d.]+\s+Tf/.exec(body)?.[1] ?? "";
    const position = /1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/.exec(body);
    const codes: string[] = [];
    const stringToken = /<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g;
    let token: RegExpExecArray | null;
    while ((token = stringToken.exec(body)) !== null) {
      if (token[1] !== undefined) {
        codes.push(token[1]);
      } else if (token[2] !== undefined) {
        codes.push(
          [...(token[2] as string)]
            .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
            .join(""),
        );
      }
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
 * Разбор содержимого страницы: текстовые фрагменты с цветом заливки и
 * размещения изображений. Цвет оператора действует до следующего, поэтому
 * содержимое читается одним проходом.
 */
function parseContent(content: string): {
  runs: Array<TextRun & { color: PdfColor | null }>;
  placements: PdfImagePlacement[];
  colors: PdfColor[];
} {
  const runs: Array<TextRun & { color: PdfColor | null }> = [];
  const placements: PdfImagePlacement[] = [];
  const colors: PdfColor[] = [];
  let currentColor: PdfColor | null = null;

  const events = [
    ...[...content.matchAll(/\/Device(RGB|Gray|CMYK)\s+cs/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "cs" as const,
      value: m[1] as string,
    })),
    ...[...content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+scn/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "color" as const,
      value: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
    })),
    ...[...content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "color" as const,
      value: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
    })),
    ...[...content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+RG/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "stroke" as const,
      value: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
    })),
    ...[...content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+scn/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "color" as const,
      value: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
    })),
    ...[...content.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+SCN/g)].map((m) => ({
      at: m.index ?? 0,
      kind: "stroke" as const,
      value: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
    })),
    ...[...content.matchAll(/([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+cm\s*\/(\w+)\s+Do/g)].map(
      (m) => ({
        at: m.index ?? 0,
        kind: "image" as const,
        value: {
          name: m[7] as string,
          scaleX: Number(m[1]),
          scaleY: Number(m[4]),
          x: Number(m[5]),
          y: Number(m[6]),
        },
      }),
    ),
  ].sort((a, b) => a.at - b.at);

  let cursor = 0;
  for (const event of events) {
    if (event.kind === "cs") {
      const block = content.slice(cursor, event.at);
      for (const run of collectTextRuns(block)) runs.push({ ...run, color: currentColor });
      cursor = event.at;
      continue;
    }
    if (event.kind === "color") {
      const block = content.slice(cursor, event.at);
      for (const run of collectTextRuns(block)) runs.push({ ...run, color: currentColor });
      cursor = event.at;
      currentColor = event.value;
      colors.push(event.value);
      continue;
    }
    if (event.kind === "stroke") {
      // Цвет контура не влияет на цвет текста, но входит в палитру бланка.
      const block = content.slice(cursor, event.at);
      for (const run of collectTextRuns(block)) runs.push({ ...run, color: currentColor });
      cursor = event.at;
      colors.push(event.value);
      continue;
    }
    placements.push(event.value);
  }

  for (const run of collectTextRuns(content.slice(cursor))) runs.push({ ...run, color: currentColor });

  return { runs, placements, colors };
}

export function parsePdf(raw: Buffer): ParsedPdf {
  const objects = parseObjects(raw);

  const cmapByFontObject = new Map<number, Map<number, string>>();
  const baseFontByFontObject = new Map<number, string>();
  const images: PdfImage[] = [];

  for (const object of objects.values()) {
    if (/\/Subtype\s*\/Type0/.test(object.dict)) {
      baseFontByFontObject.set(
        object.id,
        /\/BaseFont\s*\/([^\s/\]>]+)/.exec(object.dict)?.[1] ?? "",
      );
      const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(object.dict)?.[1];
      if (toUnicodeRef !== undefined) {
        const cmapObject = objects.get(Number(toUnicodeRef));
        if (cmapObject?.stream) {
          let content = "";
          try {
            content = zlib.inflateSync(cmapObject.stream).toString("latin1");
          } catch {
            content = cmapObject.stream.toString("latin1");
          }
          cmapByFontObject.set(object.id, decodeCMap(content));
        }
      }
    }
    if (/\/Subtype\s*\/Image/.test(object.dict)) {
      images.push({
        width: Number(/\/Width\s+(\d+)/.exec(object.dict)?.[1] ?? "0"),
        height: Number(/\/Height\s+(\d+)/.exec(object.dict)?.[1] ?? "0"),
      });
    }
  }

  const fontObjectByResource = new Map<string, number>();
  for (const object of objects.values()) {
    const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict);
    if (!fontBlock) continue;
    for (const entry of (fontBlock[1] as string).matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      fontObjectByResource.set(entry[1] as string, Number(entry[2]));
    }
  }

  const fonts: PdfFont[] = [...fontObjectByResource.entries()].map(
    ([resourceName, objectId]) => ({
      resourceName,
      baseFont: baseFontByFontObject.get(objectId) ?? "",
    }),
  );

  const colors: PdfColor[] = [];
  const placements: PdfImagePlacement[] = [];
  const decodedRuns: PdfTextRun[] = [];
  const pieces: string[] = [];
  let lastY: number | null = null;

  for (const object of objects.values()) {
    if (!object.stream) continue;
    let content = "";
    try {
      content = zlib.inflateSync(object.stream).toString("latin1");
    } catch {
      content = object.stream.toString("latin1");
    }
    if (!/(Tj|TJ)/.test(content) && !/\sDo\s/.test(content)) continue;

    const parsedContent = parseContent(content);
    colors.push(...parsedContent.colors);
    placements.push(...parsedContent.placements);

    for (const run of parsedContent.runs) {
      const fontObject = fontObjectByResource.get(run.resourceName);
      const cmap = fontObject === undefined ? undefined : cmapByFontObject.get(fontObject);
      let decoded = "";
      for (let i = 0; i + 4 <= run.codes.length; i += 4) {
        const code = Number.parseInt(run.codes.slice(i, i + 4), 16);
        if (Number.isNaN(code)) continue;
        decoded += cmap?.get(code) ?? "";
      }
      if (decoded.length === 0) continue;
      decodedRuns.push({
        resourceName: run.resourceName,
        text: decoded,
        color: run.color,
        x: run.x,
        y: run.y,
      });
      if (lastY !== null && Number.isFinite(run.y) && Math.abs(run.y - lastY) > 0.5) {
        pieces.push("\n");
      }
      pieces.push(decoded);
      lastY = Number.isFinite(run.y) ? run.y : lastY;
    }
  }

  const mediaBox = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(
    [...objects.values()].map((object) => object.dict).join("\n"),
  );

  return {
    text: pieces.join(""),
    fonts,
    images,
    placements,
    colors,
    runs: decodedRuns,
    pageWidth: mediaBox ? Number(mediaBox[3]) : 0,
    pageHeight: mediaBox ? Number(mediaBox[4]) : 0,
  };
}

export function extractText(raw: Buffer): string {
  return parsePdf(raw).text;
}
