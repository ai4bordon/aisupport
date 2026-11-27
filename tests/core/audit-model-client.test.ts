import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpModelClient } from "@/core/model";
import * as modelModule from "@/core/model";

/**
 * Стоимость вызова модели: факт провайдера, оценка по тарифу, неизвестно.
 *
 * Находки аудита BUGSAUDIT-2026-11-27:
 * - C7 — стоимость молча обнулялась, когда провайдер не отдавал
 *   `usage.opencode.list_cost`; нужен явный признак источника стоимости;
 * - C8 — курс доллара был зашит в коде (`DEFAULT_USD_TO_RUB = 100`);
 * - C8-NaN — `NaN` из `amounts` попадал в результат.
 *
 * Тесты не ходят в базу: проверяется только клиент модели.
 */

/** Ответ провайдера с заданным телом. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Клиент, который отвечает одним заданным телом. */
function clientWith(payload: unknown, model = "deepseek-v4.1-flash") {
  const fetchImpl = (async () => jsonResponse(payload)) as unknown as typeof fetch;
  return createHttpModelClient({
    baseUrl: "https://model.test",
    apiKey: "test-key",
    model,
    fetchImpl,
  });
}

/** Текст вопроса: телу ответа провайдера он не нужен. */
const REQUEST = { messages: [{ role: "user" as const, content: "вопрос" }] };

describe("стоимость вызова модели", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("факт провайдера переводится в рубли по курсу из окружения", async () => {
    vi.stubEnv("MODEL_USD_TO_RUB", "100");

    const result = await clientWith({
      choices: [{ message: { content: "Готово" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        opencode: { list_cost: 0.001 },
      },
    }).complete(REQUEST);

    expect(result.costRub).toBeCloseTo(0.1, 6);
    expect(result.costSource).toBe("provider");
    expect(result.costNote).toBeNull();
  });

  it("курс из окружения меняет стоимость: 200 вместо 100", async () => {
    vi.stubEnv("MODEL_USD_TO_RUB", "200");

    const result = await clientWith({
      choices: [{ message: { content: "Готово" } }],
      usage: { opencode: { list_cost: 0.001 } },
    }).complete(REQUEST);

    expect(result.costRub).toBeCloseTo(0.2, 6);
    expect(result.costSource).toBe("provider");
  });

  it("без цены провайдера стоимость оценивается по тарифу модели с пометкой", async () => {
    vi.stubEnv("MODEL_USD_TO_RUB", "100");

    const result = await clientWith({
      choices: [{ message: { content: "Готово" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }).complete(REQUEST);

    // Молчаливого нуля нет: стоимость посчитана по тарифу и помечена.
    expect(result.costSource).toBe("tariff");
    expect(result.costRub).toBeGreaterThan(0);
    expect(result.costNote).toContain("тариф");
  });

  it("неизвестная модель без тарифа даёт признак «стоимость неизвестна», а не молчаливый ноль", async () => {
    vi.stubEnv("MODEL_USD_TO_RUB", "100");

    const result = await clientWith(
      {
        choices: [{ message: { content: "Готово" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
      "модель-без-тарифа",
    ).complete(REQUEST);

    expect(result.costSource).toBe("unknown");
    expect(result.costNote).toContain("модель-без-тарифа");
  });

  it("без курса в окружении стоимость в рублях неизвестна, а не посчитана по зашитому 100", async () => {
    vi.stubEnv("MODEL_USD_TO_RUB", "");

    const result = await clientWith({
      choices: [{ message: { content: "Готово" } }],
      usage: { opencode: { list_cost: 0.001 } },
    }).complete(REQUEST);

    expect(result.costSource).toBe("unknown");
    expect(result.costNote).toContain("MODEL_USD_TO_RUB");
    expect(result.costRub).toBe(0);
  });

  it("курс доллара не зашит в коде: модуль не экспортирует константу по умолчанию", () => {
    expect("DEFAULT_USD_TO_RUB" in modelModule).toBe(false);
  });

  it("NaN из amounts не попадает в результат", async () => {
    const result = await clientWith({
      choices: [
        {
          message: {
            content: JSON.stringify({
              text: "Итого 5000 рублей.",
              amounts: ["не число", 5000, null],
            }),
          },
        },
      ],
    }).complete(REQUEST);

    expect(result.amounts.every((amount) => Number.isFinite(amount))).toBe(true);
    expect(result.amounts).toEqual([5000]);
  });
});
