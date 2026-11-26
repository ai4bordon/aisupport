/**
 * Минимальные типы для `pdfkit`.
 *
 * Отдельный пакет `@types/pdfkit` в проекте нет, а общие файлы (`package.json`,
 * `tsconfig.json`) срез не правит. Модуль объявляет только то, что использует
 * срез «документы», чтобы типы документов проверялись без установки нового
 * пакета.
 */
declare module "pdfkit" {
  interface TextOptions {
    align?: "left" | "center" | "right" | "justify";
    continued?: boolean;
    lineBreak?: boolean;
    width?: number;
    height?: number;
    underline?: boolean;
  }

  interface RectOptions {
    width?: number;
    height?: number;
    color?: string | number[];
    opacity?: number;
    lineWidth?: number;
    blendMode?: string;
  }

  interface ImageOptions {
    width?: number;
    height?: number;
    align?: "left" | "center" | "right";
    link?: string;
  }

  interface DocumentOptions {
    size?: string | [number, number];
    margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
    bufferPages?: boolean;
    compress?: boolean;
    info?: {
      Title?: string;
      Author?: string;
      Subject?: string;
      Keywords?: string;
      Creator?: string;
      Producer?: string;
    };
  }

  interface PDFDocument {
    x: number;
    y: number;
    page: {
      width: number;
      height: number;
      margins: { top: number; right: number; bottom: number; left: number };
    };
    pageCount: number;
    registerFont(name: string, src: string | Buffer): PDFDocument;
    font(src: string, size?: number): PDFDocument;
    fontSize(size: number): PDFDocument;
    fillColor(color: string | number[]): PDFDocument;
    strokeColor(color: string | number[]): PDFDocument;
    lineWidth(width: number): PDFDocument;
    text(text: string, x?: number, y?: number, options?: TextOptions): PDFDocument;
    moveDown(lineGap?: number): PDFDocument;
    moveTo(x: number, y: number): PDFDocument;
    lineTo(x: number, y: number): PDFDocument;
    rect(x: number, y: number, width: number, height: number): PDFDocument;
    fill(color?: string | number[]): PDFDocument;
    stroke(color?: string | number[]): PDFDocument;
    image(src: string, x: number, y: number, options?: ImageOptions): PDFDocument;
    save(): PDFDocument;
    restore(): PDFDocument;
    addPage(options?: DocumentOptions): PDFDocument;
    end(): void;
    widthOfString(text: string, options?: { align?: string }): number;
    heightOfString(text: string, options?: TextOptions): number;
    on(event: "data", listener: (chunk: Buffer) => void): PDFDocument;
    on(event: "end", listener: () => void): PDFDocument;
    on(event: "error", listener: (error: Error) => void): PDFDocument;
  }

  class PDFDocument {
    constructor(options?: DocumentOptions);
  }

  export = PDFDocument;
}
