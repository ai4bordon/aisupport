/**
 * Клиент модели.
 *
 * Основной адрес — DeepSeek через OpenCode Go, запасной адрес задаётся
 * переменной окружения. Лимиты (docs/api-contract.md §10):
 * - ожидание первого токена — 120 с;
 * - повтор после 429 — ровно один, через 30 с;
 * - повторная ошибка — `ModelUnavailableError`.
 *
 * Ключ модели живёт только в переменной окружения и в трассу не попадает.
 */

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelRequest = {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type ModelResult = {
  text: string;
  /** Суммы, которые модель заявила в ответе: их проверяет валидатор. */
  amounts: number[];
  /** Цитаты, которые модель заявила в ответе. */
  citations: string[];
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  /** Идентификатор модели без ключа — попадает в трассу. */
  model: string;
};

export type ModelClient = {
  complete: (request: ModelRequest) => Promise<ModelResult>;
};

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

/** Предел ожидания первого токена, секунды. */
export const FIRST_TOKEN_TIMEOUT_SECONDS = 120;
/** Пауза перед единственным повтором после 429, секунды. */
export const RETRY_AFTER_429_SECONDS = 30;

type FetchLike = typeof fetch;

type ClientOptions = {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  fetchImpl?: FetchLike;
  /** Пауза перед повтором: по умолчанию 30 с, в тестах — мгновенно. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Пауза перед повтором.
 *
 * `Promise.withResolvers` требует lib ES2024, а проект зафиксирован на
 * ES2023, поэтому используется форма с исполнителем.
 */
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Разбор ответа провайдера: текст, суммы, цитаты и метрики.
 *
 * Суммы и цитаты модель возвращает в структурированном виде — отдельными
 * полями в JSON-ответе. Разбор не вычисляет ничего: только переносит
 * числа, названные моделью, чтобы валидатор сверил их с источником.
 */
function parseModelPayload(payload: unknown): ModelResult {
  const record = (payload ?? {}) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = record.choices?.[0]?.message?.content ?? "";

  let text = content;
  let amounts: number[] = [];
  let citations: string[] = [];

  const jsonStart = content.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(content.slice(jsonStart)) as {
        text?: string;
        amounts?: number[];
        citations?: string[];
      };
      if (typeof parsed.text === "string") text = parsed.text;
      if (Array.isArray(parsed.amounts)) amounts = parsed.amounts.map(Number);
      if (Array.isArray(parsed.citations)) citations = parsed.citations.map(String);
    } catch {
      // Ответ не в JSON: берём текст как есть, суммы и цитаты не заявляются.
    }
  }

  return {
    text,
    amounts,
    citations,
    tokensIn: record.usage?.prompt_tokens ?? 0,
    tokensOut: record.usage?.completion_tokens ?? 0,
    costRub: 0,
    model: "",
  };
}

/**
 * Клиент модели с одним повтором после 429.
 *
 * Реальный вызов требует ключа владельца; без него используется
 * детерминированная заглушка на границе.
 */
export function createHttpModelClient(options: ClientOptions): ModelClient {
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      if (!options.apiKey || !options.baseUrl) {
        throw new ModelUnavailableError("Ключ модели не задан");
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        FIRST_TOKEN_TIMEOUT_SECONDS * 1000,
      );

      const call = async (): Promise<Response> => {
        const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: request.messages,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 1024,
          }),
          signal: controller.signal,
        });
        return response;
      };

      try {
        let response = await call();

        // Ровно один повтор после 429 — через 30 секунд.
        if (response.status === 429) {
          await sleep(RETRY_AFTER_429_SECONDS * 1000);
          response = await call();
        }

        if (response.status === 429) {
          throw new ModelUnavailableError("Провайдер модели вернул 429 повторно");
        }
        if (!response.ok) {
          throw new ModelUnavailableError(`Провайдер модели вернул ${response.status}`);
        }

        const payload = (await response.json()) as unknown;
        const result = parseModelPayload(payload);
        return { ...result, model: options.model };
      } catch (error) {
        if (error instanceof ModelUnavailableError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new ModelTimeoutError(
            `Превышен таймаут ожидания первого токена (${FIRST_TOKEN_TIMEOUT_SECONDS} с)`,
          );
        }
        throw new ModelUnavailableError(
          error instanceof Error ? error.message : "Неизвестная ошибка модели",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * Заглушка модели на границе.
 *
 * Без ключа владельца живой вызов невозможен; заглушка даёт детерминированный
 * ответ, чтобы поведение ядра можно было проверить целиком.
 */
export const stubModelClient: ModelClient = {
  complete: async (_request: ModelRequest): Promise<ModelResult> => ({
    text: "",
    amounts: [],
    citations: [],
    tokensIn: 0,
    tokensOut: 0,
    costRub: 0,
    model: "stub",
  }),
};

let activeClient: ModelClient = stubModelClient;

/** Подмена клиента модели — только для тестов и песочницы. */
export function setModelClient(client: ModelClient): void {
  activeClient = client;
}

export function getModelClient(): ModelClient {
  return activeClient;
}

/** Клиент по умолчанию из переменных окружения. */
export function createDefaultModelClient(): ModelClient {
  return createHttpModelClient({
    baseUrl: process.env.OPENCODE_BASE_URL,
    apiKey: process.env.OPENCODE_API_KEY,
    model: process.env.LLM_MODEL ?? "deepseek-chat",
  });
}
