// @vitest-environment node
/**
 * Интеграционный тест среза «документы» (тикет 02).
 *
 * Команда проверки: `npm run test -- tests/integration/02-quote-invoice.test.ts`
 *
 * Тест собирает срез целиком: расчёт кодом → черновик КП по шаблону
 * заказчика → счёт по собственному шаблону команды → проверка полей в
 * собранных PDF и проверка записи в таблицы `templates`/`documents`.
 *
 * Все входные значения — синтетические допущения: позиция каталога и цены
 * вымышлены, настоящих данных фида заказчика в тесте нет.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/docs/quote/route";
import { renderInvoice, renderQuote } from "@/modules/documents";
import type { InvoiceInput, QuoteInput } from "@/modules/documents";
import { parsePdf } from "../documents/pdf-inspect";

const DATABASE_URL = process.env.DATABASE_URL;

const quoteInput = (): QuoteInput => ({
  number: "Исх. № бн от 26.11.2026",
  date: "26.11.2026",
  customerName: "ООО «Ромашка»",
  lines: [
    {
      offerId: "SYNTH-OFFER-001",
      name: "Синтетическая лицензия KES Standard, 1 устройство",
      quantity: 50,
      price: 1200,
      amount: 60000,
      vat: 10000,
    },
  ],
  total: 60000,
  vatTotal: 10000,
  paymentTerms: "prepaid",
  deliveryTerm: "В тот же рабочий день после оплаты (допущение для электронной лицензии)",
  validUntil: "26.12.2026",
});

const invoiceInput = (tenantId: string, conversationId: string): InvoiceInput => ({
  tenantId,
  conversationId,
  customerName: "ООО «Ромашка»",
  date: "26.11.2026",
  lines: quoteInput().lines,
  total: 60000,
  vatTotal: 10000,
  goodsDescription: "лицензии на программное обеспечение",
  paymentPurpose: "Оплата по счёту за лицензии по договору поставки",
  paymentDue: "5 рабочих дней с момента выставления счёта",
});

beforeAll(async () => {
  process.env.DOCUMENTS_DIR = await mkdtemp(join(tmpdir(), "aisupport-docs-integration-"));
});

describe("Срез 02: КП и счёт", () => {
  it("формирует черновик КП по шаблону заказчика", async () => {
    const rendered = await renderQuote(quoteInput());
    const parsed = parsePdf(await readFile(rendered.pdfPath));

    expect(rendered.kind).toBe("quote");
    expect(rendered.amount).toBe(60000);

    // Поля шаблона заказчика.
    expect(parsed.text).toContain("ООО «Ромашка»");
    expect(parsed.text).toContain("Исх. № бн от 26.11.2026");
    expect(parsed.text).toContain("ПАО «Софтлайн»");
    expect(parsed.text).toContain("Уважаемый заказчик!");
    expect(parsed.text).toContain("Артикул");
    expect(parsed.text).toContain("Наименование");
    expect(parsed.text).toContain("Кол-во");
    expect(parsed.text).toContain("Цена, руб.");
    expect(parsed.text).toContain("Сумма, руб.");
    expect(parsed.text).toContain("В т.ч. НДС, руб.");
    expect(parsed.text).toContain("Итого");
    expect(parsed.text).toContain(
      "Цена указана с учетом всех налогов, сборов, и других обязательных платежей.",
    );
    expect(parsed.text).toContain("Условия оплаты: Предоплата.");
    expect(parsed.text).toContain("Срок поставки:");
    expect(parsed.text).toContain("Срок действия коммерческого предложения - до 26.12.2026.");
    expect(parsed.text).toContain("Директор департамента");

    // НДС и итог посчитаны кодом по входному расчёту.
    expect(parsed.text).toContain("60 000");
    expect(parsed.text).toContain("10 000");
    expect(parsed.text).not.toMatch(/\{\{|\}\}/);
  });

  it("формирует счёт по собственному шаблону команды с номером и привязкой к обращению", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const rendered = await renderInvoice(invoiceInput(tenantId, conversationId));
    const parsed = parsePdf(await readFile(rendered.pdfPath));

    expect(rendered.kind).toBe("invoice");
    expect(rendered.number).toMatch(/^СЧ-20261126-\d{3}$/);
    expect(rendered.amount).toBe(60000);
    expect(parsed.text).toContain("Счёт № СЧ-20261126-001");
    expect(parsed.text).toContain("Получатель:");
    expect(parsed.text).toContain("Назначение платежа:");
    expect(parsed.text).toContain("Срок оплаты:");
    expect(parsed.text).toContain("В том числе НДС 10 000 руб.");
    // Счёт — не КП: собственный шаблон команды.
    expect(parsed.text).not.toContain("коммерческое предложение");
  });

  it("печатает документы на корпоративном бланке Softline", async () => {
    const rendered = await renderQuote(quoteInput());
    const parsed = parsePdf(await readFile(rendered.pdfPath));

    // Логотип «Софтлайн Решения + SOFL» без искажений.
    expect(parsed.images.some((image) => image.width === 2000 && image.height === 442)).toBe(true);
    const placement = parsed.placements[0];
    expect(placement).toBeDefined();
    expect(Math.abs((placement?.scaleX ?? 0) / (placement?.scaleY ?? 1))).toBeCloseTo(2000 / 442, 2);

    // Montserrat, слоган в подвале, подтверждённые реквизиты.
    expect(parsed.fonts.every((font) => font.baseFont.includes("Montserrat"))).toBe(true);
    expect(parsed.text).toContain("Мы знаем. Мы можем.");
    expect(parsed.text).toContain("info@softline.com");
  });

  it("блокирует документ при пустом обязательном поле и при расхождении сумм", async () => {
    await expect(renderQuote({ ...quoteInput(), customerName: " " })).rejects.toMatchObject({
      code: "document_field_missing",
      field: "customerName",
    });
    await expect(renderQuote({ ...quoteInput(), total: 10 })).rejects.toMatchObject({
      code: "amount_mismatch",
    });
  });

  it("отдаёт 200 с документом через маршрут POST /docs/quote", async () => {
    const response = await POST(
      new Request("http://localhost/docs/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(quoteInput()),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; amount: number; pdfPath: string };
    expect(body.kind).toBe("quote");
    expect(body.amount).toBe(60000);
    expect(body.pdfPath).toMatch(/\.pdf$/);
  });

  it.runIf(DATABASE_URL)("сохраняет шаблон и документ в базе среза", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const tenant = await pool.query<{ id: string }>(
        "SELECT id FROM tenants WHERE slug = 'demo-tenant'",
      );
      const tenantId = tenant.rows[0]?.id;
      expect(tenantId).toBeTruthy();

      const conversation = await pool.query<{ id: string }>(
        "INSERT INTO conversations (tenant_id, channel, status) VALUES ($1, 'web', 'open') RETURNING id",
        [tenantId],
      );
      const conversationId = conversation.rows[0]?.id as string;

      await pool.query(
        `INSERT INTO templates (tenant_id, kind, name, body, placeholders, is_active)
         VALUES ($1, 'quote', 'КП ПАО «Софтлайн»', $2, $3::jsonb, true)
         ON CONFLICT (tenant_id, kind, name, version) DO NOTHING`,
        [tenantId, "Уважаемый заказчик! {{customerName}}", JSON.stringify(["customerName"])],
      );

      const rendered = await renderInvoice(invoiceInput(tenantId as string, conversationId));
      // Номер счёта детерминирован, поэтому запись предыдущего прогона
      // удаляется: тест не зависит от порядка запусков.
      await pool.query(
        "DELETE FROM documents WHERE tenant_id = $1 AND kind = 'invoice' AND number = $2",
        [tenantId, rendered.number],
      );
      await pool.query(
        `INSERT INTO documents (tenant_id, conversation_id, kind, number, amount, vat, pdf_path)
         VALUES ($1, $2, 'invoice', $3, $4, $5, $6)`,
        [tenantId, conversationId, rendered.number, rendered.amount, 10000, rendered.pdfPath],
      );

      const stored = await pool.query<{ number: string; pdf_path: string; conversation_id: string }>(
        "SELECT number, pdf_path, conversation_id FROM documents WHERE tenant_id = $1 AND kind = 'invoice' AND number = $2",
        [tenantId, rendered.number],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.number).toBe(rendered.number);
      // Связь с обращением сохранена.
      expect(stored.rows[0]?.conversation_id).toBe(conversationId);
      expect(stored.rows[0]?.pdf_path).toBe(rendered.pdfPath);

      // Номер счёта уникален в пределах тенанта.
      await expect(
        pool.query(
          `INSERT INTO documents (tenant_id, conversation_id, kind, number, amount, vat)
           VALUES ($1, $2, 'invoice', $3, 1, 0)`,
          [tenantId, conversationId, rendered.number],
        ),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
