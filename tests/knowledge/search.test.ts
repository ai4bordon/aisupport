import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/db/pool";
import { search, setEmbeddingProvider, type EmbeddingProvider } from "@/modules/knowledge";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

/**
 * Проверка допуска к поиску: в выдачу попадают только одобренные материалы.
 *
 * Фикстура: опубликованная статья, черновик статьи и документ `pending`.
 * Эмбеддинги детерминированные — внешний API векторов в тестах не вызывается.
 *
 * Тест работает на своём арендаторе: файлы тестов идут параллельно и не
 * должны затирать фикстуры друг друга.
 */
const TENANT_SLUG = "test-knowledge-search";
const EMBEDDING_DIMENSIONS = 1536;

/** Вектор, совпадающий с детерминированным провайдером по тем же словам. */
function embeddingFor(words: string[]): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of words) {
    const stem = word.toLowerCase().slice(0, 6);
    let hash = 2166136261;
    for (let index = 0; index < stem.length; index += 1) {
      hash ^= stem.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  return vector;
}

async function seedFixtures(): Promise<{ tenantId: string; publishedArticleId: string }> {
  const tenantId = await resetTenant(TENANT_SLUG);

  const published = await testPool().query<{ id: string }>(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
     VALUES ($1, 'Лицензирование', 'Электронная лицензия предоставляется в течение 120 минут после оплаты.', 'published', now(), now())
     RETURNING id`,
    [tenantId],
  );
  const publishedArticleId = published.rows[0]?.id ?? "";

  await testPool().query(
    `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from)
     VALUES ($1, 'Постоплата', 'Отсрочка платежа предоставляется по письменному согласованию.', 'draft', now())`,
    [tenantId],
  );

  const document = await testPool().query<{ id: string }>(
    `INSERT INTO kb_documents (tenant_id, filename, mime_type, size_bytes, storage_path, status)
     VALUES ($1, 'pending.pdf', 'application/pdf', 100, '/tmp/pending.pdf', 'pending')
     RETURNING id`,
    [tenantId],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, publishedArticleId, "Электронная лицензия предоставляется в течение 120 минут после оплаты.", `[${embeddingFor(["Электронная", "лицензия", "предоставляется"]).join(",")}]`],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, (SELECT id FROM kb_articles WHERE title = 'Постоплата' AND tenant_id = $1), 0, $2, to_tsvector('russian', $2), $3::vector, 'deterministic-hash-v1')`,
    [tenantId, "Отсрочка платежа предоставляется по письменному согласованию.", `[${embeddingFor(["Отсрочка", "платежа", "предоставляется"]).join(",")}]`],
  );

  await testPool().query(
    `INSERT INTO kb_chunks (tenant_id, document_id, chunk_no, text, search_vector, embedding, embedding_model)
     VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
    [tenantId, document.rows[0]?.id ?? "", "Материал загруженного документа ждёт одобрения менеджера.", `[${embeddingFor(["Материал", "загруженного", "документа"]).join(",")}]`],
  );

  return { tenantId, publishedArticleId };
}

describe("поиск по базе знаний", () => {
  let tenantId = "";
  let publishedArticleId = "";

  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    const fixtures = await seedFixtures();
    tenantId = fixtures.tenantId;
    publishedArticleId = fixtures.publishedArticleId;
  });

  afterAll(async () => {
    await closePool();
  });

  it("возвращает только опубликованные материалы", async () => {
    const results = await search("лицензия", tenantId);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.articleId === publishedArticleId || result.title === "Лицензирование").toBe(true);
    }
  });

  it("в выдаче нет содержимого черновика и неодобренного документа", async () => {
    const results = await search("Отсрочка платежа предоставляется по письменному согласованию.", tenantId);
    const texts = results.map((result) => result.text);

    expect(texts.join(" ")).not.toContain("Отсрочка платежа");
    expect(texts.join(" ")).not.toContain("ждёт одобрения");
  });

  it("поиск по тексту черновика возвращает пустой результат", async () => {
    const results = await search("Отсрочка платежа", tenantId);

    expect(results).toEqual([]);
  });

  it("пустой результат возвращает [], а не выдуманный ответ", async () => {
    const results = await search("квантовая телепортация астероидов", tenantId);

    expect(results).toEqual([]);
  });

  it("limit ограничивает число результатов", async () => {
    const results = await search("лицензия", tenantId, 1);

    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("возвращает ссылку на источник", async () => {
    const results = await search("Электронная лицензия предоставляется", tenantId);

    expect(results[0]?.articleId).toBe(publishedArticleId);
    expect(results[0]?.title).toBe("Лицензирование");
    expect(results[0]?.chunkId).toBeTruthy();
  });

  it("смысловой поиск находит статью по вопросу без точных слов", async () => {
    // Регрессия: поиск сравнивал вектор запроса с вектором чанка, построенными
    // разными моделями, и смысловой поиск не работал. Здесь провайдер запроса
    // и провайдер индекса — один, и вектор строится по смыслу.
    const semanticProvider: EmbeddingProvider = {
      model: "test-semantic-v1",
      embed: async (text: string) => {
        // Вектор зависит от смысла, а не от слов: «не могу войти» и
        // «восстановление пароля» дают один и тот же вектор.
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const meaning = /вход|войти|парол|доступ|авторизац/i.test(text)
          ? "access"
          : "other";
        vector[meaning === "access" ? 7 : 900] = 1;
        return vector;
      },
    };

    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 1, $3, to_tsvector('russian', $3), $4::vector, 'test-semantic-v1')`,
      [
        tenantId,
        publishedArticleId,
        "Восстановление пароля от личного кабинета: инструкция по сбросу.",
        `[${(() => {
          const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
          vector[7] = 1;
          return vector;
        })().join(",")}]`,
      ],
    );

    setEmbeddingProvider(semanticProvider);
    const results = await search("не могу войти в личный кабинет", tenantId);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe("Лицензирование");
  });

  it("чанк, проиндексированный другой моделью, не попадает в выдачу", async () => {
    // Вектор запроса и вектор чанка строятся разными моделями: сравнивать их
    // бессмысленно, поэтому чанк отвергается по модели индекса.
    const otherModelProvider: EmbeddingProvider = {
      model: "other-model-v2",
      embed: async () => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        vector[7] = 1;
        return vector;
      },
    };

    setEmbeddingProvider(otherModelProvider);
    const results = await search("восстановление пароля", tenantId);

    expect(results).toEqual([]);
  });

  it("материал с точным совпадением попадает в выдачу, даже если вектор заполнил лимит", async () => {
    // Регрессия живьёма (UX-аудит 28.11): вопрос «Как оплатить подписку?».
    // Векторный поиск давал пять сходных материалов и занимал лимит, а
    // текстовая ветка выполнялась только как запасная — при полном лимите
    // она не выполнялась вовсе. Инструкция «Способы оплаты заказа» не
    // попадала в выдачу, и агент отвечал по другим статьям или уходил в
    // эскалацию.
    const tenant = await resetTenant(TENANT_SLUG);

    // Пять «шумных» материалов: вектор с ними схож, текстового совпадения
    // с вопросом нет.
    for (let index = 0; index < 5; index += 1) {
      const article = await testPool().query<{ id: string }>(
        `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
         VALUES ($1, $2, $3, 'published', now(), now()) RETURNING id`,
        [tenant, `Справочник ${index}`, `Справочник API номер ${index} для разработчиков.`],
      );
      await testPool().query(
        `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
         VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
        [
          tenant,
          article.rows[0]?.id ?? "",
          `Справочник API номер ${index} для разработчиков.`,
          `[${embeddingFor(["справочник", "разработчиков", "номер"]).join(",")}]`,
        ],
      );
    }

    // Инструкция: текстовое совпадение с вопросом, вектор с ней не схож.
    const payment = await testPool().query<{ id: string }>(
      `INSERT INTO kb_articles (tenant_id, title, body_md, status, valid_from, approved_at)
       VALUES ($1, 'Способы оплаты заказа', 'В панели управления клиента доступны способы оплаты счетов.', 'published', now(), now())
       RETURNING id`,
      [tenant],
    );
    await testPool().query(
      `INSERT INTO kb_chunks (tenant_id, article_id, chunk_no, text, search_vector, embedding, embedding_model)
       VALUES ($1, $2, 0, $3, to_tsvector('russian', $3), $4::vector, 'deterministic-hash-v1')`,
      [
        tenant,
        payment.rows[0]?.id ?? "",
        "В панели управления клиента доступны способы оплаты счетов.",
        `[${embeddingFor(["панели", "управления", "клиента"]).join(",")}]`,
      ],
    );

    // Вектор запроса совпадает со «шумными» материалами и не совпадает с
    // инструкцией: так выглядит случай на стенде, где векторная выдача
    // занимала лимит целиком.
    setEmbeddingProvider({
      model: "deterministic-hash-v1",
      embed: async () => embeddingFor(["справочник", "разработчиков", "номер"]),
    });

    const results = await search("Как оплатить счета?", tenant);

    // Вектор заполнил лимит — пять шумных материалов.
    expect(results.length).toBe(5);
    // Инструкция с точным совпадением по словам в выдаче осталась.
    expect(results.some((result) => result.title === "Способы оплаты заказа")).toBe(true);
  });
});
