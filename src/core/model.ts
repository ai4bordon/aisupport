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
  /**
   * Источник стоимости вызова.
   *
   * `provider` — цена из ответа провайдера (`usage.opencode.list_cost`);
   * `tariff` — оценка по тарифу модели, потому что провайдер цену не отдал;
   * `unknown` — стоимость в рублях вычислить не удалось.
   *
   * Поле необязательное: клиенты, подставленные в тестах и песочнице,
   * стоимость не считают. Отсутствие поля означает «стоимость не считалась».
   */
  costSource?: CostSource;
  /**
   * Пометка к стоимости: чем она посчитана и почему может быть нулевой.
   *
   * Ноль без пометки читался бы как «модель бесплатна», а это разные
   * факты: «цена провайдера неизвестна» и «вызов ничего не стоил».
   */
  costNote?: string | null;
  /** Идентификатор модели без ключа — попадает в трассу. */
  model: string;
};

/**
 * Источник стоимости вызова модели.
 *
 * Разные источники означают разные факты, поэтому они различаются явно:
 * ноль без признака означал бы «модель бесплатна».
 */
export type CostSource = "provider" | "tariff" | "unknown";

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
 * Курс доллара в рулях: только из окружения.
 *
 * Провайдер считает стоимость в долларах, а трасса и счётчики бюджета
 * работают в рублях. Курс задаётся конфигом: `MODEL_USD_TO_RUB`.
 *
 * Зашитого курса в коде нет: денежный фолбэк молча менял бы экономику
 * демо на 10–25 %. Переменная обязательна для расчёта в рублях; без неё
 * стоимость помечается как неизвестная (см. `resolveUsdToRub`).
 */
const USD_TO_RUB_ENV = "MODEL_USD_TO_RUB";

/**
 * Тариф моделей: долларов за токен.
 *
 * Значения выведены из проверочных трасс ADR-0007: `deepseek-v4.1-flash` —
 * 238 токенов при `list_cost` $0.00011445, `deepseek-v4-pro` — 1363 токена
 * при `list_cost` $0.00254562. Это средняя цена токена по конкретным
 * ответам, а не прайс провайдера, поэтому оценка всегда идёт с пометкой.
 *
 * Модель без тарифа стоимости не получает: цена неизвестна, и это
 * объявляется явно.
 */
const MODEL_TARIFFS: ReadonlyArray<{
  /** Признак имени модели: входит в идентификатор модели. */
  match: string;
  /** Долларов за один токен (вход и выход вместе). */
  usdPerToken: number;
}> = [
  {
    match: "deepseek-v4.1-flash",
    // 0.00011445 $ / 238 токенов.
    usdPerToken: 4.8088e-7,
  },
  {
    match: "deepseek-v4-pro",
    // 0.00254562 $ / 1363 токена.
    usdPerToken: 1.8678e-6,
  },
];

/**
 * Курс доллара в рулях из окружения.
 *
 * Возвращает курс и, если курса нет, явную причину: без курса стоимость
 * в рублях не вычислить, и это не то же самое, что «вызов ничего не стоил».
 */
function resolveUsdToRub(): { rate: number | null; problem: string | null } {
  const raw = process.env[USD_TO_RUB_ENV];
  if (raw === undefined || raw.trim() === "") {
    return {
      rate: null,
      problem: `${USD_TO_RUB_ENV} не задан: стоимость в рублях не считается`,
    };
  }
  const rate = Number.parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      rate: null,
      problem: `${USD_TO_RUB_ENV} задан некорректно («${raw}»): нужен положительный курс`,
    };
  }
  return { rate, problem: null };
}

/**
 * Тариф модели в долларах за токен.
 *
 * Модель без тарифа возвращает `null`: цена такой модели неизвестна, и
 * подставлять чужую было бы выдумкой.
 */
function tariffFor(model: string): number | null {
  for (const tariff of MODEL_TARIFFS) {
    if (model.includes(tariff.match)) return tariff.usdPerToken;
  }
  return null;
}

/**
 * Стоимость вызова в рублях и источник, из которого она получена.
 *
 * OpenCode Go в ответе отдаёт `usage.opencode.list_cost` — полную цену
 * вызова в долларах — и `usage.opencode.allowance` — часть, покрытую
 * подпиской. В трассу идёт полная стоимость: экономика демо считается по
 * факту, а не по остатку подписки.
 *
 * Порядок источников:
 * 1. цена провайдера (`list_cost`) — факт;
 * 2. тариф модели по числу токенов — оценка, всегда с пометкой;
 * 3. ничего не известно — стоимость неизвестна, а не ноль.
 */
function costFromUsage(
  usage: unknown,
  model: string,
): { costRub: number; source: CostSource; note: string | null } {
  const record = (usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    opencode?: { list_cost?: number; allowance?: number };
  };
  const { rate, problem } = resolveUsdToRub();
  const listCost = record.opencode?.list_cost;
  const hasProviderCost =
    typeof listCost === "number" && Number.isFinite(listCost) && listCost > 0;

  if (hasProviderCost && rate !== null) {
    // Округление до четырёх знаков — та же точность, что у
    // `usage_counters.spend_rub`. Округление до копеек обнуляло бы стоимость
    // дешёвых вызовов (классификация стоит доли копейки), и в трассе
    // экономика выглядела бы как «модель бесплатна».
    return {
      costRub: Math.round(listCost * rate * 10_000) / 10_000,
      source: "provider",
      note: null,
    };
  }

  if (rate === null) {
    return {
      costRub: 0,
      source: "unknown",
      note: problem,
    };
  }

  if (hasProviderCost) {
    // Цена провайдера есть, но курса нет: в рублях стоимость неизвестна.
    return {
      costRub: 0,
      source: "unknown",
      note: problem,
    };
  }

  const tokensIn = Number.isFinite(record.prompt_tokens) ? (record.prompt_tokens ?? 0) : 0;
  const tokensOut = Number.isFinite(record.completion_tokens) ? (record.completion_tokens ?? 0) : 0;
  const tokens = tokensIn + tokensOut;
  const usdPerToken = tariffFor(model);
  if (usdPerToken === null || tokens <= 0) {
    return {
      costRub: 0,
      source: "unknown",
      note: `Цена вызова провайдером не отдана, тариф модели «${model}» неизвестен: стоимость неизвестна`,
    };
  }

  const usd = tokens * usdPerToken;
  return {
    costRub: Math.round(usd * rate * 10_000) / 10_000,
    source: "tariff",
    note: `Цена вызова провайдером не отдана: стоимость оценена по тарифу модели «${model}» (${tokens} токенов)`,
  };
}

/**
 * Суммы, которые модель заявила: только конечные числа.
 *
 * Модель может вернуть в `amounts` строку, `null` или `NaN`. Такие значения
 * не суммы: `NaN` в ответе превращался в нарушение «сумма не найдена в
 * источнике» или в `NaN` в трассе. Конечные числа сохраняются как есть.
 */
function parseAmounts(values: unknown[]): number[] {
  const amounts: number[] = [];
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) amounts.push(value);
      continue;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) amounts.push(parsed);
    }
    // `null`, `undefined`, объекты и нечисловые строки — не суммы.
  }
  return amounts;
}

/**
 * Разбор ответа провайдера: текст, суммы, цитаты и метрики.
 *
 * Суммы и цитаты модель возвращает в структурированном виде — отдельными
 * полями в JSON-ответе. Разбор не вычисляет ничего: только переносит
 * числа, названные моделью, чтобы валидатор сверил их с источником.
 */
function parseModelPayload(payload: unknown, model: string): ModelResult {
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
        if (Array.isArray(parsed.amounts)) amounts = parseAmounts(parsed.amounts);
        if (Array.isArray(parsed.citations)) citations = parsed.citations.map(String);
      } catch {
        // Ответ не в JSON: берём текст как есть, суммы и цитаты не заявляются.
      }
    }
  }

  const cost = costFromUsage(record.usage, model);

  return {
    text,
    amounts,
    citations,
    tokensIn: record.usage?.prompt_tokens ?? 0,
    tokensOut: record.usage?.completion_tokens ?? 0,
    costRub: cost.costRub,
    costSource: cost.source,
    costNote: cost.note,
    model,
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
        const result = parseModelPayload(payload, options.model);
        return result;
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
    // Заглушка модель не вызывала: стоимость не считалась, и это отличается
    // от «вызов стоил ноль».
    costSource: "unknown",
    costNote: "Модель не вызывалась: стоимость не считалась",
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
