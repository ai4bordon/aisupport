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
  /**
   * Идентификатор диалога: из него получается заголовок `x-opencode-session`,
   * который OpenCode Go требует для чат-эндпоинта.
   */
  sessionId?: string;
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
  /**
   * Предел ожидания первого токена одного HTTP-вызова, миллисекунды.
   *
   * По умолчанию — 120 с (`FIRST_TOKEN_TIMEOUT_SECONDS`). Предел задаётся
   * на каждый вызов отдельно: повтор после 429 получает свой полный
   * предел, а не остаток первого вызова. Значение нужно тестам: без него
   * проверка тайм-аута ждала бы реальные две минуты.
   */
  timeoutMs?: number;
  /**
   * Идентификатор сессии для заголовка `x-opencode-session`.
   *
   * OpenCode Go требует этот заголовок: без него чат-эндпоинт отвечает
   * 400 «Request is missing x-opencode-session». Значение берётся из
   * идентификатора диалога, поэтому маршрутизация и кэш промптов
   * привязаны к диалогу.
   */
  sessionId?: string;
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
 * Понятное объяснение отказа провайдера.
 *
 * У OpenCode Go две типовые причины, и обе требуют действия владельца,
 * а не повтора: модель вне регионов Europe/United States (нужно включить
 * Global в Console → Settings → Privacy) и модель, не входящая в Go.
 * Без разбора сообщение об ошибке остаётся непонятным пользователю.
 */
async function describeProviderFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = body.slice(0, 400);
  if (response.status === 400 && /region|country|Global/i.test(body)) {
    return `Провайдер модели вернул 400: модель недоступна для текущего региона. Нужно включить Global в Console → Settings → Privacy. ${detail}`;
  }
  if (response.status === 400 && /x-opencode-session/i.test(body)) {
    return `Провайдер модели вернул 400: отсутствует заголовок x-opencode-session. ${detail}`;
  }
  if (response.status === 400 && /not included|not available in/i.test(body)) {
    return `Провайдер модели вернул 400: модель не входит в подписку Go. ${detail}`;
  }
  if (response.status === 402) {
    return `Провайдер модели вернул 402: недостаточно средств на счёте. ${detail}`;
  }
  if (response.status === 403) {
    return `Провайдер модели вернул 403: эндпоинт недоступен для этой модели. ${detail}`;
  }
  return `Провайдер модели вернул ${response.status}. ${detail}`;
}

/**
 * Курс доллара в рулях для перевода стоимости вызова модели.
 *
 * Провайдер считает стоимость в долларах, а трасса и счётчики бюджета
 * работают в рублях. Курс задаётся конфигом: `MODEL_USD_TO_RUB`.
 */
export const DEFAULT_USD_TO_RUB = 100;

/**
 * Стоимость вызова в рублях по данным провайдера.
 *
 * OpenCode Go в ответе отдаёт `usage.opencode.list_cost` — полную цену
 * вызова в долларах — и `usage.opencode.allowance` — часть, покрытую
 * подпиской. В трассу идёт полная стоимость: экономика демо считается по
 * факту, а не по остатку подписки.
 */
function costRubFromUsage(usage: unknown): number {
  const record = (usage ?? {}) as {
    opencode?: { list_cost?: number; allowance?: number };
  };
  const listCost = record.opencode?.list_cost;
  if (typeof listCost !== "number" || !Number.isFinite(listCost) || listCost <= 0) {
    return 0;
  }
  const rate = Number.parseFloat(process.env.MODEL_USD_TO_RUB ?? "");
  const usdToRub = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_RUB;
  // Округление до четырёх знаков — та же точность, что у
  // `usage_counters.spend_rub`. Округление до копеек обнуляло бы стоимость
  // дешёвых вызовов (классификация стоит доли копейки), и в трассе
  // экономика выглядела бы как «модель бесплатна».
  return Math.round(listCost * usdToRub * 10_000) / 10_000;
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
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      opencode?: { list_cost?: number; allowance?: number };
    };
  };
  const content = record.choices?.[0]?.message?.content ?? "";

  let text = content;
  let amounts: number[] = [];
  let citations: string[] = [];

  // Модель часто оборачивает JSON в блок кода: ```json {...} ```. Хвост после
  // объекта ломает `JSON.parse`, поэтому берётся сам объект — от первой
  // открывающей скобки до последней закрывающей.
  const jsonStart = content.indexOf("{");
  if (jsonStart >= 0) {
    const jsonEnd = content.lastIndexOf("}");
    const candidate = jsonEnd > jsonStart ? content.slice(jsonStart, jsonEnd + 1) : "";
    if (candidate.length > 0) {
      try {
        const parsed = JSON.parse(candidate) as {
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
  }

  return {
    text,
    amounts,
    citations,
    tokensIn: record.usage?.prompt_tokens ?? 0,
    tokensOut: record.usage?.completion_tokens ?? 0,
    costRub: costRubFromUsage(record.usage),
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
  const timeoutMs = options.timeoutMs ?? FIRST_TOKEN_TIMEOUT_SECONDS * 1000;

  return {
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      if (!options.apiKey || !options.baseUrl) {
        throw new ModelUnavailableError("Ключ модели не задан");
      }

      /**
       * Один HTTP-вызов с собственным пределом ожидания первого токена.
       *
       * Контроллер отмены и таймер живут только внутри вызова: предел
       * относится к каждому отдельному запросу, поэтому повтор после 429
       * получает свой полный предел, а не остаток первого вызова. Общий
       * контроллер на весь объект клиента отменял бы повтор уже истёкшим
       * сигналом.
       */
      const call = async (): Promise<Response> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          };
          // Идентификатор сессии обязателен для Go-эндпоинта чата.
          const sessionId = request.sessionId ?? options.sessionId;
          if (sessionId) {
            headers["x-opencode-session"] = sessionId.startsWith("ses_")
              ? sessionId
              : `ses_${sessionId}`;
          }
          const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: options.model,
              messages: request.messages,
              temperature: request.temperature ?? 0.2,
              maxTokens: request.maxTokens ?? 1024,
              // Рассуждение модели выключено: иначе DeepSeek расходует весь
              // лимит токенов на скрытое рассуждение, `content` остаётся пустым,
              // а короткий бюджет шага (32 токена на классификацию) исчерпывается
              // ни на что.
              reasoning_effort: "none",
            }),
            signal: controller.signal,
          });
          return response;
        } finally {
          clearTimeout(timeout);
        }
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
          throw new ModelUnavailableError(
            await describeProviderFailure(response),
          );
        }

        const payload = (await response.json()) as unknown;
        const result = parseModelPayload(payload);
        return { ...result, model: options.model };
      } catch (error) {
        if (error instanceof ModelUnavailableError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new ModelTimeoutError(
            `Превышен таймаут ожидания первого токена (${timeoutMs >= 1000 ? `${timeoutMs / 1000} с` : `${timeoutMs} мс`})`,
          );
        }
        throw new ModelUnavailableError(
          error instanceof Error ? error.message : "Неизвестная ошибка модели",
        );
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

let activeClient: ModelClient | null = null;

/** Подмена клиента модели — только для тестов и песочницы. */
export function setModelClient(client: ModelClient): void {
  activeClient = client;
}

/**
 * Клиент модели для боевого пути.
 *
 * Пока клиент не подменён тестом или песочницей, берётся реальный клиент из
 * переменных окружения. Раньше здесь стояла заглушка, и живой вызов модели не
 * происходил вовсе: ответ приходил пустым, а счётчик токенов оставался нулём.
 */
export function getModelClient(): ModelClient {
  activeClient ??= createDefaultModelClient();
  return activeClient;
}

/** Клиент по умолчанию из переменных окружения. */
export function createDefaultModelClient(): ModelClient {
  return createHttpModelClient({
    // Подписка OpenCode Go обслуживается отдельным путём: /inference/go/v1.
    // Адрес /inference/openai/v1 — это pay-as-you-go по кредитам Console,
    // и с подпиской Go он всегда отвечает 402 или 429.
    baseUrl:
      process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/inference/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    model: process.env.LLM_MODEL ?? "deepseek-v4.1-flash",
  });
}
