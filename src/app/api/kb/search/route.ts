import { getPool } from "@/db/pool";
import { search } from "@/modules/knowledge";
import { getTenantId } from "@/db/tenant";

/**
 * GET /kb/search — поиск по одобренной базе знаний (docs/api-contract.md §6).
 *
 * В выдачу попадают только опубликованные статьи и документы. Арендатор
 * определяется сервером, из запроса не принимается.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const limitParam = url.searchParams.get("limit");

  if (query.length === 0 || query.length > 2000) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Параметр q обязателен и ограничен 2000 символами",
          details: {},
          request_id: crypto.randomUUID(),
        },
      },
      { status: 400 },
    );
  }

  const limit = limitParam === null ? 5 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Параметр limit должен быть целым от 1 до 20",
          details: {},
          request_id: crypto.randomUUID(),
        },
      },
      { status: 400 },
    );
  }

  try {
    const tenantId = await getTenantId();
    const matches = await search(query, tenantId, limit);
    return Response.json({
      matches: matches.map((match) => ({
        article_id: match.articleId,
        chunk_id: match.chunkId,
        title: match.title,
        text: match.text,
        location: match.location,
        score: match.score,
      })),
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "upstream_unavailable",
          message: "База данных недоступна",
          details: {},
          request_id: crypto.randomUUID(),
        },
      },
      { status: 503 },
    );
  }
}
