import { randomUUID } from "node:crypto";

import { getTenantId } from "@/db/tenant";
import { checkManagerAccess } from "@/modules/access";
import {
  KnowledgeDocumentError,
  documentHttpStatus,
  uploadDocument,
} from "@/modules/document-upload";

/**
 * POST /kb/documents — загрузка документа базы знаний (docs/api-contract.md §6).
 *
 * Порядок: барьер кабинета менеджера → чтение файла и проверка размера →
 * определение формата → разбор и индексация → ответ `202` со статусом
 * «на проверке».
 *
 * Арендатор определяется сервером: `tenant_id` из тела запроса не принимается.
 * Формат ответа — snake_case, как требует провенанс контракта §2.
 */

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        details,
        request_id: randomUUID(),
      },
    },
    { status },
  );
}

export async function POST(request: Request): Promise<Response> {
  const decision = await checkManagerAccess({
    cookieHeader: request.headers.get("cookie"),
  });
  if (!decision.allowed) {
    return errorResponse(401, "unauthorized", "Код доступа менеджера не принят");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, "validation_error", "Ожидается multipart/form-data с полем file");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorResponse(400, "validation_error", "Поле file обязательно");
  }

  // Арендатор берётся на сервере: тело запроса его не задаёт.
  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return errorResponse(503, "upstream_unavailable", "База данных недоступна");
  }

  try {
    const record = await uploadDocument({
      tenantId,
      filename: file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
      uploadedBy: "manager",
    });

    return Response.json(
      {
        id: record.id,
        status: record.status,
        filename: record.filename,
        mime_type: record.mimeType,
        chunks_count: record.chunksCount,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof KnowledgeDocumentError) {
      return errorResponse(documentHttpStatus(error.code), error.code, error.message, {
        field: error.field,
      });
    }
    return errorResponse(500, "internal_error", "Не удалось обработать документ");
  }
}
