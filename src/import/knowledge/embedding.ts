/**
 * Клиент эмбеддингов по замороженной спецификации контракта.
 *
 * Контракт §0.2: порт эмбеддингов заморожен — HTTP-эндпоинт и формат ответа.
 * Каждый срез реализует свой тонкий клиент, чтобы не зависеть от кода соседей.
 *
 * Секреты — только в переменных окружения: `OPENCODE_API_KEY`, `OPENCODE_BASE_URL`,
 * `EMBEDDING_MODEL`. В коде, тестах и логах ключа нет.
 */

export type EmbeddingProvider = {
  /** Возвращает вектор для текста. */
  embed(text: string): Promise<number[]>;
  /** Размерность вектора. */
  readonly dimensions: number;
};

export const EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_URL = "https://opencode.ai/inference/go/openai/v1/embeddings";

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
};

/**
 * Клиент эмбеддингов OpenAI-совместимого эндпоинта.
 *
 * @param options адрес, ключ и модель; по умолчанию — из окружения.
 */
export function createEmbeddingProvider(options?: {
  url?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): EmbeddingProvider {
  const url = options?.url ?? process.env["OPENCODE_EMBEDDINGS_URL"] ?? DEFAULT_EMBEDDING_URL;
  const apiKey = options?.apiKey ?? process.env["OPENCODE_API_KEY"] ?? "";
  const model = options?.model ?? process.env["EMBEDDING_MODEL"] ?? DEFAULT_EMBEDDING_MODEL;
  const timeoutMs = options?.timeoutMs ?? 60_000;

  return {
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(text: string): Promise<number[]> {
      if (apiKey.length === 0) {
        throw new Error("Не задан OPENCODE_API_KEY: векторы построить нельзя");
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Эмбеддинги недоступны: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as EmbeddingResponse;
      const vector = payload.data?.[0]?.embedding;
      if (!vector || vector.length === 0) {
        const reason = payload.error?.message ?? "пустой ответ";
        throw new Error(`Эмбеддинги вернули пустой вектор: ${reason}`);
      }
      return vector;
    },
  };
}

/**
 * Детерминированный провайдер для тестов и офлайн-развёртывания.
 *
 * Вектор строится из хеша текста: одинаковый текст даёт одинаковый вектор,
 * поэтому поиск и тесты детерминированы. Ключ модели не нужен.
 *
 * @param dimensions размерность вектора.
 */
export function createDeterministicEmbeddingProvider(dimensions = EMBEDDING_DIMENSIONS): EmbeddingProvider {
  return {
    dimensions,
    async embed(text: string): Promise<number[]> {
      const vector = new Array<number>(dimensions).fill(0);
      // Разносим символы по координатам: близкие тексты дают близкие векторы.
      let h = 2166136261;
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
        const bucket = Math.abs(h) % dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (norm === 0) return vector;
      return vector.map((value) => value / norm);
    },
  };
}
