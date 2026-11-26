/**
 * Рендер документов среза «документы».
 *
 * Модуль делает три вещи:
 *  1. проверяет обязательные поля и сверяет итог с входным расчётом;
 *  2. подставляет значения в шаблон;
 *  3. собирает PDF на корпоративном бланке Softline (ADR-0012, R26).
 *
 * Вся геометрия и палитра бланка — в `templates.ts`: правка стиля не
 * задевает ни проверку полей, ни расчёты.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PDFDocument from "pdfkit";

import type { DocumentErrorCode, RenderedDocument } from "./types";
import type { DocumentBlock, FontKey, TableColumn, TableRow } from "./templates";
import {
  bodyFontSize,
  bodyTextColor,
  companyDetails,
  corporateSlogan,
  fontSubsetOverrides,
  fonts,
  layout,
  logoGuardRatio,
  logoPath,
  quoteSigner,
} from "./templates";

/** Ошибка модуля документов: пустое поле или расхождение сумм. */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  readonly field: string | null;

  constructor(code: DocumentErrorCode, field: string | null, message: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.field = field;
  }
}

/** Значение, готовое к подстановке в шаблон. */
export type TemplateValue = string | number;

export type TemplateValues = Record<string, TemplateValue>;

const placeholderPattern = /\{\{([a-zA-Z0-9_]+)\}\}/g;

function isBlank(value: TemplateValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  return value.trim().length === 0;
}

/**
 * Проверяет обязательные поля: пустое значение блокирует документ ошибкой
 * `document_field_missing` с именем поля.
 */
export function assertRequiredFields(
  values: TemplateValues,
  required: readonly string[],
): void {
  for (const field of required) {
    if (isBlank(values[field])) {
      throw new DocumentError(
        "document_field_missing",
        field,
        `обязательное поле документа не заполнено: ${field}`,
      );
    }
  }
}

/**
 * Сверяет итог и НДС с входным расчётом: код считает суммы, пришедшие извне
 * значения не доверяет. Расхождение блокирует документ `amount_mismatch`.
 */
export function assertAmountMatches(
  expected: { total: number; vatTotal: number },
  actual: { total: number; vatTotal: number },
): void {
  if (expected.total !== actual.total) {
    throw new DocumentError(
      "amount_mismatch",
      "total",
      `итог документа (${actual.total}) не совпадает с расчётом (${expected.total})`,
    );
  }
  if (expected.vatTotal !== actual.vatTotal) {
    throw new DocumentError(
      "amount_mismatch",
      "vatTotal",
      `НДС документа (${actual.vatTotal}) не совпадает с расчётом (${expected.vatTotal})`,
    );
  }
}

/** Подставляет значения в текст; неизвестный плейсхолдер остаётся видимым. */
export function substitute(text: string, values: TemplateValues): string {
  return text.replace(placeholderPattern, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    return String(value);
  });
}

/**
 * Начертание бланка: Montserrat (ADR-0012, R26). Пакет `@fontsource/montserrat`
 * разбит на сабсеты — кириллица лежит в `cyrillic`, цифры и латиница — в
 * `latin`. pdfkit не переключает шрифт внутри строки, поэтому строка
 * набирается фрагментами по сабсетам.
 */
type FontName = "body" | "bodyBold" | "bodyLatin" | "bodyBoldLatin";

const fontNames: Record<FontKey, { regular: FontName; bold: FontName }> = {
  cyrillic: { regular: "body", bold: "bodyBold" },
  latin: { regular: "bodyLatin", bold: "bodyBoldLatin" },
};

function isCyrillic(char: string): boolean {
  return /[Ѐ-ӿ]/.test(char);
}

/** Фрагмент строки, набранный одним сабсетом шрифта. */
type Run = { key: FontKey; text: string };

function splitBySubset(text: string): Run[] {
  const runs: Run[] = [];
  for (const char of text) {
    const override = fontSubsetOverrides[char];
    const key: FontKey = override ?? (isCyrillic(char) ? "cyrillic" : "latin");
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.text += char;
    else runs.push({ key, text: char });
  }
  return runs;
}

type DrawContext = {
  doc: PDFKit.PDFDocument;
  values: TemplateValues;
};

/** Межстрочный интервал основного текста бланка. */
const lineHeight = bodyFontSize * 1.35;

/**
 * Пишет строку фрагментами по сабсетам шрифта.
 *
 * Позиция каждого фрагмента считается явно: pdfkit не умеет переключать
 * шрифт внутри строки, а смещение фрагмента нужно, чтобы латиница и
 * кириллица встали в одну строку без разрыва.
 */
function drawRuns(
  context: DrawContext,
  text: string,
  options: { bold?: boolean; align?: "left" | "right" | "center" } = {},
): number {
  const doc = context.doc;
  const bold = options.bold === true;
  const runs = splitBySubset(text);
  if (runs.length === 0) return 0;

  const width = runs.reduce((sum, run) => {
    const name = bold ? fontNames[run.key].bold : fontNames[run.key].regular;
    return sum + doc.font(name).widthOfString(run.text);
  }, 0);

  const right = doc.page.width - doc.page.margins.right;
  let x =
    options.align === "right"
      ? right - width
      : options.align === "center"
        ? doc.page.width / 2 - width / 2
        : doc.x;
  const y = doc.y;

  for (const run of runs) {
    const name = bold ? fontNames[run.key].bold : fontNames[run.key].regular;
    doc.font(name).text(run.text, x, y, { lineBreak: false });
    x = doc.x;
  }

  doc.x = x;
  doc.y = y + lineHeight;
  return width;
}

function drawTable(context: DrawContext, columns: TableColumn[], rows: TableRow[]): void {
  const doc = context.doc;
  const padding = layout.table.cellPadding;
  const widths = columns.map((column) => column.width);
  const lineHeight = bodyFontSize * 1.6;
  const startX = doc.page.margins.left;
  let rowY = doc.y;

  const drawCell = (
    text: string,
    x: number,
    width: number,
    align: "left" | "right",
    bold: boolean,
    fill: string | null,
  ): void => {
    if (fill) {
      doc.save().rect(x, rowY, width, lineHeight).fill(fill).restore();
    }
    doc
      .save()
      .rect(x, rowY, width, lineHeight)
      .lineWidth(0.5)
      .strokeColor(layout.colors.tableBorder)
      .stroke()
      .restore();
    const textWidth = doc.font("body").widthOfString(text);
    const offset = align === "right" ? width - padding - textWidth : padding;
    doc.x = x + offset;
    doc.y = rowY + (lineHeight - bodyFontSize) / 2;
    drawRuns(context, text, { bold, align: "left" });
  };

  let x = startX;
  for (const [index, column] of columns.entries()) {
    drawCell(
      column.label,
      x,
      widths[index] as number,
      column.align ?? "left",
      true,
      layout.colors.tableHeaderFill,
    );
    x += widths[index] as number;
  }
  rowY += lineHeight;

  for (const row of rows) {
    x = startX;
    for (const [index, column] of columns.entries()) {
      drawCell(
        substitute(row.cells[column.key] ?? "", context.values),
        x,
        widths[index] as number,
        column.align ?? "left",
        row.kind === "total",
        null,
      );
      x += widths[index] as number;
    }
    rowY += lineHeight;
  }

  doc.x = startX;
  doc.y = rowY;
}

type LogoBuffer = { path: string; width: number; height: number };

let logoCache: LogoBuffer | null = null;

async function readLogo(): Promise<LogoBuffer> {
  if (logoCache) return logoCache;
  const path = logoPath();
  const buffer = await readFile(path);
  // Размеры логотипа — из заголовка PNG (IHDR): пропорции сохраняются.
  logoCache = { path, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  return logoCache;
}

/**
 * Рисует шапку бланка: логотип с охранным полем и подтверждённые реквизиты
 * ПАО «Софтлайн» (ADR-0012 §1.4–1.7, §6.15).
 */
async function drawHeader(context: DrawContext): Promise<void> {
  const doc = context.doc;
  const margin = layout.page.margin;
  const logoWidth = layout.header.logoWidth;

  const logo = await readLogo();
  const logoHeight = (logoWidth * logo.height) / logo.width;

  doc.save().rect(margin, margin, logoWidth, logoHeight).fill("#ffffff").restore();
  doc.image(logo.path, margin, margin, { width: logoWidth, height: logoHeight });

  // Охранное поле вокруг логотипа — не меньше его высоты (ADR-0012 §1.7).
  const guard = logoHeight * logoGuardRatio;
  const detailsX = margin + logoWidth + guard;

  doc.fillColor(layout.colors.headerText).fontSize(bodyFontSize + 1);
  doc.x = detailsX;
  doc.y = margin;
  drawRuns(context, companyDetails.legalName, { bold: true });

  doc.fillColor(bodyTextColor).fontSize(bodyFontSize);
  drawRuns(context, companyDetails.address);
  drawRuns(context, `${companyDetails.phone} | ${companyDetails.email}`);
  drawRuns(context, `${companyDetails.site} | ${companyDetails.siteAlt}`);

  // Реквизиты документа — справа, в зоне охранного поля логотипа.
  doc.fillColor(bodyTextColor).fontSize(bodyFontSize);
  doc.x = detailsX;
  doc.y = margin;
  drawRuns(context, `Куда: ${context.values.customerName ?? ""}`, { align: "right" });
  drawRuns(context, `Исх. № ${context.values.number ?? ""} от ${context.values.date ?? ""}`, {
    align: "right",
  });

  doc.x = margin;
  doc.y = margin + logoHeight + guard;
  doc.moveDown(0.6);
  doc
    .save()
    .moveTo(margin, doc.y)
    .lineTo(doc.page.width - margin, doc.y)
    .lineWidth(1)
    .strokeColor(layout.colors.rule)
    .stroke()
    .restore();
  doc.moveDown(0.8);
}

/** Рисует подвал бланка с корпоративным слоганом (ADR-0012 §3.1, R26). */
function drawFooter(context: DrawContext): void {
  const doc = context.doc;
  const margin = layout.page.margin;
  const bottom = doc.page.height - margin;

  doc
    .save()
    .moveTo(margin, bottom - layout.footer.sloganGap)
    .lineTo(doc.page.width - margin, bottom - layout.footer.sloganGap)
    .lineWidth(0.5)
    .strokeColor(layout.colors.footerText)
    .stroke()
    .restore();

  doc.fillColor(layout.colors.footerText).fontSize(bodyFontSize);
  doc.x = margin;
  doc.y = bottom - layout.footer.sloganGap + 6;
  drawRuns(context, corporateSlogan, { align: "center" });
}

export type RenderInput = {
  kind: "quote" | "invoice";
  number: string;
  amount: number;
  values: TemplateValues;
  blocks: DocumentBlock[];
  outputPath: string;
};
/**
 * Собирает PDF по шаблону. Ошибки проверки полей и расхождение сумм
 * приходят до сборки файла: при ошибке документ не создаётся.
 */
export async function renderDocument(input: RenderInput): Promise<RenderedDocument> {
  await mkdir(join(input.outputPath, ".."), { recursive: true });

  const doc = new PDFDocument({
    size: layout.page.size,
    margin: layout.page.margin,
    bufferPages: true,
    info: { Title: `${input.kind} ${input.number}`, Producer: "aisupport" },
  });
  doc.registerFont("body", fonts.cyrillic[400]);
  doc.registerFont("bodyBold", fonts.cyrillic[600]);
  doc.registerFont("bodyLatin", fonts.latin[400]);
  doc.registerFont("bodyBoldLatin", fonts.latin[600]);

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const { promise: finished, resolve: resolveFinished } = Promise.withResolvers<void>();
  doc.on("end", resolveFinished);

  const context: DrawContext = { doc, values: input.values };

  await drawHeader(context);

  for (const block of input.blocks) {
    if (block.kind === "paragraph") {
      doc.fillColor(bodyTextColor).fontSize(bodyFontSize);
      drawRuns(context, substitute(block.text, input.values));
      doc.moveDown(0.4);
      continue;
    }
    drawTable(context, block.columns, block.rows);
    doc.moveDown(0.8);
  }

  // Подписант — фиксированный текст шаблона, подставляет код.
  doc.fillColor(bodyTextColor).fontSize(bodyFontSize);
  doc.moveDown(1.2);
  drawRuns(context, quoteSigner.name);
  drawRuns(context, quoteSigner.position);

  drawFooter(context);

  doc.end();
  await finished;

  await writeFile(input.outputPath, Buffer.concat(chunks));

  return {
    kind: input.kind,
    number: input.number,
    pdfPath: input.outputPath,
    amount: input.amount,
  };
}

/** Каталог для готовых документов: переменная окружения или временный. */
export function documentsDirectory(): string {
  return process.env.DOCUMENTS_DIR ?? join(tmpdir(), "aisupport-documents");
}
