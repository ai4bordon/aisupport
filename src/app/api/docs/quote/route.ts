/**
 * Маршрут `POST /docs/quote` — формирование черновика КП по шаблону
 * заказчика (docs/api-contract.md §3, §7).
 *
 * Тело — `QuoteInput` по контракту §0.3. Ответ `200` содержит
 * `RenderedDocument`. Пустое обязательное поле — `422 approval_required` с
 * указанием поля; расхождение сумм — `422` с кодом `amount_mismatch`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { DocumentError, renderQuote } from "@/modules/documents";
import type { QuoteInput } from "@/modules/documents";

const lineSchema = z.object({
  offerId: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number(),
  price: z.number(),
  amount: z.number(),
  vat: z.number(),
});

const quoteSchema = z.object({
  number: z.string().min(1),
  date: z.string().min(1),
  customerName: z.string().min(1),
  lines: z.array(lineSchema).min(1),
  total: z.number(),
  vatTotal: z.number(),
  paymentTerms: z.enum(["prepaid", "postpaid"]),
  deliveryTerm: z.string().min(1),
  validUntil: z.string().min(1),
  vatRate: z.number().optional(),
});

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        details,
        request_id: crypto.randomUUID(),
      },
    },
    { status },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "validation_error", "Тело запроса не разобрано", {});
  }

  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "validation_error", "Тело запроса не прошло схему", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const rendered = await renderQuote(parsed.data as QuoteInput);
    return NextResponse.json(rendered, { status: 200 });
  } catch (cause) {
    if (cause instanceof DocumentError) {
      if (cause.code === "amount_mismatch") {
        return errorResponse(422, "amount_mismatch", cause.message, { field: cause.field });
      }
      return errorResponse(422, "approval_required", cause.message, { field: cause.field });
    }
    return errorResponse(500, "internal_error", "Не удалось сформировать документ", {});
  }
}
