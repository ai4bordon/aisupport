// @vitest-environment node
import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/docs/quote/route";

/**
 * Маршрут `POST /docs/quote` (docs/api-contract.md §3, §7).
 *
 * Тест вызывает обработчик напрямую: контракт маршрута — тело запроса,
 * код ответа и тело ответа.
 */

function quoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    deliveryTerm: "В тот же рабочий день после оплаты (допущение)",
    validUntil: "26.12.2026",
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost/docs/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /docs/quote", () => {
  it("возвращает 200 с готовым документом", async () => {
    const response = await POST(request(quoteBody()));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      number: string;
      pdfPath: string;
      amount: number;
    };
    expect(body.kind).toBe("quote");
    expect(body.amount).toBe(60000);
    expect(body.pdfPath).toMatch(/\.pdf$/);
  });

  it("возвращает 422 approval_required с указанием поля при пустом обязательном поле", async () => {
    const response = await POST(request(quoteBody({ customerName: "  " })));

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; details: { field: string } };
    };
    expect(body.error.code).toBe("approval_required");
    expect(body.error.details.field).toBe("customerName");
  });

  it("возвращает 422 с кодом amount_mismatch при расхождении итога", async () => {
    const response = await POST(request(quoteBody({ total: 1 })));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("amount_mismatch");
  });

  it("возвращает 400 validation_error при теле не по схеме", async () => {
    const response = await POST(request({ number: "без позиций" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});
