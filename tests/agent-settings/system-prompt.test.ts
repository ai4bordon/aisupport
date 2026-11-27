import { describe, expect, it } from "vitest";
import { defaultSystemPrompt } from "@/modules/agent-settings";

/**
 * Системный промпт по умолчанию.
 *
 * Промпт хранится в модуле настроек и подставляется в модель вместо
 * константы ядра: сохранённая конфигурация определяет, по чему отвечает
 * агент. Поэтому в промпте обязаны быть правила, без которых ответ агента
 * небезопасен, — их набор проверяется здесь, а текст целиком сверяется с
 * ядром тестом настроек (по фактическому запросу к модели).
 */
describe("системный промпт по умолчанию", () => {
  it("содержит обязательные правила безопасного ответа", () => {
    const prompt = defaultSystemPrompt();

    expect(prompt).toContain("Отвечай только по подтверждённым источникам");
    expect(prompt).toContain("Не выдумывай суммы, условия и факты");
    expect(prompt).toContain("Персональные данные в запросе заменены метками");
    expect(prompt).toContain("Ответ верни в JSON");
    expect(prompt).toContain("Ссылки и URL в текст ответа не вставляй");
  });

  it("не содержит ключей и секретов", () => {
    const prompt = defaultSystemPrompt();

    expect(prompt).not.toMatch(/api[_-]?key|password|authorization|bearer/i);
  });
});
