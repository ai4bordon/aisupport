/**
 * Шаблоны документов среза «документы».
 *
 * Модуль держит всё оформление корпоративного бланка: палитру, типографику,
 * геометрию шапки/подвала, текстовые блоки КП и счёта. Рендер и проверка
 * полей к геометрии не привязаны: правка стиля бланка не задевает логику
 * и тесты полей.
 *
 * Источники: ADR-0012 и R26 (фирменный стиль Softline), брендбук
 * `docs/лого софтлайн/Softline Guideline 2025 (1).pdf` (§1.4–1.7 логотип,
 * §2.1–2.2 цвета, §3.1 слоган, §6.15 корпоративные бланки), шаблон КП
 * заказчика `Агент поддержки-20261126T080905Z-1-001/Агент поддержки/Шаблон КП ПАО Софтлайн.pdf`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Печатная палитра Softline (ADR-0012 §2.1–2.2). Значения совпадают с
 * переменными печатной палитры из `src/app/styles/tokens.css`
 * (--sl-print-bordeaux/gray/blue/graphite): свои hex в коде не заводятся.
 */
export const printPalette = {
  bordeaux: "#a20c33",
  gray: "#a6a8ab",
  blue: "#2396d3",
  graphite: "#686968",
  black: "#000000",
} as const;

/** Основной текст бланка — чёрный (R26). */
export const bodyTextColor = printPalette.black;

/** Стек шрифтов по R26: Montserrat с системным fallback Segoe UI. */
export const fontStack = 'Montserrat, "Segoe UI", system-ui, sans-serif';

/** Кегль основного текста бланка по R26. */
export const bodyFontSize = 11;

/**
 * Охранное поле вокруг логотипа — не меньше высоты логотипа (ADR-0012 §1.7,
 * R26). Задаётся долей от высоты логотипа, чтобы правило не ломалось при
 * смене размера логотипа в шапке.
 */
export const logoGuardRatio = 1;

/**
 * Официальный логотип «Софтлайн Решения + SOFL» — цветная версия для
 * светлого фона (ADR-0012 §1.4, §1.5). Путь относительно корня репозитория.
 */
export const logoAssetPath = "docs/лого софтлайн/Софтлайн-решения+SOFL_Logo_rgb (2).png";

/** Корпоративный слоган в подвале бланка (ADR-0012 §3.1, R26). */
export const corporateSlogan = "Мы знаем. Мы можем.";

/** Подтверждённые реквизиты ПАО «Софтлайн» из шаблона КП заказчика. */
export const companyDetails = {
  legalName: "ПАО «Софтлайн»",
  address:
    "119021, город Москва, ул Льва Толстого, д. 5 стр. 1, этаж 3, помещ. 1, ком. №2, 2а (а-311)",
  phone: "Т +7 495 232 00 23",
  email: "info@softline.com",
  site: "www.softline.ru",
  siteAlt: "www.softline.com",
} as const;

/** Подписант КП из шаблона заказчика. */
export const quoteSigner = {
  name: "Бондаренко Александр",
  position: "Директор департамента",
} as const;

/** Реквизиты получателя по умолчанию — из тестовой конфигурации (R3). */
export const invoiceRecipient = {
  name: "ООО «Ромашка»",
  inn: "7700000000",
} as const;

/**
 * Геометрия бланка: всё, что определяет вид документа, живёт здесь.
 * Размеры — в пунктах (pt), как в pdfkit.
 */
export const layout = {
  page: { size: "A4" as const, margin: 40 },
  header: {
    logoWidth: 160,
    detailsGap: 16,
  },
  footer: {
    sloganGap: 16,
  },
  table: {
    columns: [
      { key: "offerId", label: "Артикул", width: 70 },
      { key: "name", label: "Наименование", width: 210 },
      { key: "quantity", label: "Кол-во", width: 40 },
      { key: "price", label: "Цена, руб.", width: 60 },
      { key: "amount", label: "Сумма, руб.", width: 70 },
      { key: "vat", label: "В т.ч. НДС, руб.", width: 65 },
    ],
    cellPadding: 4,
  },
  colors: {
    headerText: printPalette.bordeaux,
    tableBorder: printPalette.graphite,
    tableHeaderFill: printPalette.gray,
    tableHeaderText: printPalette.black,
    accent: printPalette.blue,
    footerText: printPalette.graphite,
    rule: printPalette.bordeaux,
  },
} as const;

/**
 * Шрифт бланка. Montserrat лежит в пакете `@fontsource/montserrat`, но разбит
 * на сабсеты: кириллица — в `cyrillic`, цифры и латиница — в `latin`.
 * pdfkit не переключает шрифт внутри строки, поэтому бланк набирается двумя
 * начертаниями, а рендер выбирает сабсет по символу.
 */
export type FontKey = "cyrillic" | "latin";

export type FontWeight = 400 | 600;

function packageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@fontsource/montserrat/package.json"));
}

function fontFile(key: FontKey, weight: FontWeight): string {
  const root = packageRoot();
  const woff = join(root, "files", `montserrat-${key}-${weight}-normal.woff`);
  try {
    readFileSync(woff);
    return woff;
  } catch {
    return resolve(root, "files", `montserrat-${key}-${weight}-normal.woff2`);
  }
}

/** Файлы начертаний бланка: сабсет и вес. */
export const fonts: Record<FontKey, Record<FontWeight, string>> = {
  cyrillic: { 400: fontFile("cyrillic", 400), 600: fontFile("cyrillic", 600) },
  latin: { 400: fontFile("latin", 400), 600: fontFile("latin", 600) },
};

/**
 * Символы, которых нет в «своём» сабсете.
 *
 * Пакет `@fontsource/montserrat` разбит на сабсеты по языкам: кириллица в
 * `cyrillic` (там есть «№» и «ё»), цифры, латиница и типографика в `latin`
 * (там есть ««», «»», «—»). Кириллица уходит в `cyrillic`, всё остальное —
 * в `latin`, кроме символов из этой таблицы: они набираются тем сабсетом,
 * в котором глиф есть, иначе в PDF попадёт .notdef.
 */
export const fontSubsetOverrides: Record<string, FontKey> = {
  "№": "cyrillic",
};

/** Колонка таблицы документа. */
export type TableColumn = {
  key: string;
  label: string;
  width: number;
  align?: "left" | "right";
};

/** Ячейка таблицы: подстановка значения по ключу колонки. */
export type TableRow = {
  cells: Record<string, string>;
  kind?: "item" | "total";
};

/** Блок документа: абзац или таблица. */
export type DocumentBlock =
  | { kind: "paragraph"; text: string; align?: "left" | "right" | "center" }
  | { kind: "table"; columns: TableColumn[]; rows: TableRow[] };

const quoteTableColumns: TableColumn[] = [
  { key: "offerId", label: "Артикул", width: 70 },
  { key: "name", label: "Наименование", width: 210 },
  { key: "quantity", label: "Кол-во", width: 40, align: "right" },
  { key: "price", label: "Цена, руб.", width: 60, align: "right" },
  { key: "amount", label: "Сумма, руб.", width: 70, align: "right" },
  { key: "vat", label: "В т.ч. НДС, руб.", width: 65, align: "right" },
];

/**
 * КП по образцу заказчика: порядок полей и формулировки совпадают с
 * переданным шаблоном.
 */
export const quoteTemplate: DocumentBlock[] = [
  { kind: "paragraph", text: "Уважаемый заказчик!" },
  { kind: "paragraph", text: "{{companyLegalName}} предлагает Вашему вниманию коммерческое предложение на следующих условиях:" },
  {
    kind: "table",
    columns: quoteTableColumns,
    rows: [
      {
        kind: "item",
        cells: {
          offerId: "{{offerId}}",
          name: "{{name}}",
          quantity: "{{quantity}}",
          price: "{{price}}",
          amount: "{{amount}}",
          vat: "{{vat}}",
        },
      },
      {
        kind: "total",
        cells: {
          offerId: "",
          name: "Итого",
          quantity: "",
          price: "",
          amount: "{{total}}",
          vat: "{{vatTotal}}",
        },
      },
    ],
  },
  { kind: "paragraph", text: "Цена указана с учетом всех налогов, сборов, и других обязательных платежей." },
  { kind: "paragraph", text: "Условия оплаты: {{paymentTerms}}." },
  { kind: "paragraph", text: "Срок поставки: {{deliveryTerm}}." },
  { kind: "paragraph", text: "Срок действия коммерческого предложения - до {{validUntil}}." },
];

/**
 * Счёт — собственный шаблон команды (шаблон счёта заказчик не передавал),
 * на том же корпоративном бланке.
 */
export const invoiceTemplate: DocumentBlock[] = [
  { kind: "paragraph", text: "Счёт № {{number}} от {{date}}" },
  { kind: "paragraph", text: "Получатель: {{recipientName}}" },
  { kind: "paragraph", text: "ИНН получателя: {{recipientInn}}" },
  { kind: "paragraph", text: "За {{goodsDescription}}" },
  {
    kind: "table",
    columns: quoteTableColumns,
    rows: [
      {
        kind: "item",
        cells: {
          offerId: "{{offerId}}",
          name: "{{name}}",
          quantity: "{{quantity}}",
          price: "{{price}}",
          amount: "{{amount}}",
          vat: "{{vat}}",
        },
      },
      {
        kind: "total",
        cells: {
          offerId: "",
          name: "Итого",
          quantity: "",
          price: "",
          amount: "{{total}}",
          vat: "{{vatTotal}}",
        },
      },
    ],
  },
  { kind: "paragraph", text: "В том числе НДС {{vatTotal}} {{currency}}." },
  { kind: "paragraph", text: "Назначение платежа: {{paymentPurpose}}." },
  { kind: "paragraph", text: "Срок оплаты: {{paymentDue}}." },
];

/**
 * Обязательные поля шаблона КП: пустое значение блокирует документ.
 * Ключи совпадают с полями входной структуры `QuoteInput`. Позиции
 * (`lines`) проверяются отдельно: их отсутствие — тоже пустое обязательное
 * поле, но список позиций не строка.
 */
export const quoteRequiredFields = [
  "customerName",
  "number",
  "date",
  "total",
  "vatTotal",
  "paymentTerms",
  "deliveryTerm",
  "validUntil",
] as const;

/** Обязательные поля шаблона счёта (кроме номера — его формирует код). */
export const invoiceRequiredFields = [
  "customerName",
  "date",
  "total",
  "vatTotal",
  "goodsDescription",
  "paymentPurpose",
  "paymentDue",
] as const;

/** Путь к корню репозитория: от каталога модуля `src/modules/documents`. */
export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Абсолютный путь к файлу логотипа. */
export function logoPath(): string {
  return join(repositoryRoot(), logoAssetPath);
}

/**
 * Высота логотипа при заданной ширине: пропорции файла сохраняются, логотип
 * не растягивается и не сжимается (ADR-0012 §1.3).
 */
export function logoHeight(logoWidth: number, pixelWidth: number, pixelHeight: number): number {
  return (logoWidth * pixelHeight) / pixelWidth;
}
