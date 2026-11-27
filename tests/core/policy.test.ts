/**
 * Полномочия агента по коммерческим условиям (ADR-0019).
 *
 * Ответы заказчика от 27.11.2026: скидка без купона до 5% — решение агента,
 * выше — эскалация; отсрочка платежа и возврат средств — всегда менеджер.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { check, requestedPercent, ruleKeyForRequest } from "@/modules/policy";
import { ensureSchema, resetTenant, testPool } from "../db/helpers";

const TENANT_SLUG = "test-policy-01";

let tenantId = "";

beforeAll(async () => {
  await ensureSchema();
  tenantId = await resetTenant(TENANT_SLUG);
});

describe("полномочия агента: выбор правила по запросу", () => {
  it("скидка определяется по слову «скидка»", () => {
    expect(ruleKeyForRequest("Какая скидка на лицензию?")).toBe("discount_request");
  });

  it("отсрочка платежа определяется по «отсрочка» и «рассрочка»", () => {
    expect(ruleKeyForRequest("Можно в рассрочку?")).toBe("postpay_request");
    expect(ruleKeyForRequest("Просим отсрочку платежа")).toBe("postpay_request");
  });

  it("возврат средств определяется по «возврат»", () => {
    expect(ruleKeyForRequest("Нужен возврат денег")).toBe("refund_request");
  });

  it("вопрос без коммерческого условия правила не выбирает", () => {
    expect(ruleKeyForRequest("Как получить электронную лицензию?")).toBeNull();
  });
});

describe("полномочия агента: процент скидки из текста", () => {
  it("процент читается после слова «скидка»", () => {
    expect(requestedPercent("Какую скидку 10% вы дадите?")).toBe(10);
  });

  it("процент читается после слова «скидку» со словом «процентов»", () => {
    expect(requestedPercent("Дайте скидку 12 процентов")).toBe(12);
  });

  it("процент читается перед словом «скидка»", () => {
    expect(requestedPercent("10 процентов скидки на лицензию")).toBe(10);
  });

  it("процент не выдумывается, если клиент его не назвал", () => {
    expect(requestedPercent("Какая скидка действует?")).toBeNull();
  });
});

describe("полномочия агента: порог скидки 5%", () => {
  it("скидка до 5% — решение агента", async () => {
    const decision = await check(
      { text: "Какую скидку 5% вы дадите?", ruleKey: "discount_request", percent: 5 },
      tenantId,
    );

    expect(decision.allowed).toBe(true);
  });

  it("скидка ниже порога — решение агента", async () => {
    const decision = await check(
      { text: "Какую скидку 3% вы дадите?", ruleKey: "discount_request", percent: 3 },
      tenantId,
    );

    expect(decision.allowed).toBe(true);
  });

  it("скидка выше 5% уходит менеджеру", async () => {
    const decision = await check(
      { text: "Какую скидку 10% вы дадите?", ruleKey: "discount_request", percent: 10 },
      tenantId,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("10%");
  });

  it("скидка без названного процента остаётся за агентом в пределах порога", async () => {
    const decision = await check(
      { text: "Какая скидка действует?", ruleKey: "discount_request", percent: null },
      tenantId,
    );

    expect(decision.allowed).toBe(true);
  });

  it("отсрочка платежа всегда уходит менеджеру", async () => {
    const decision = await check(
      { text: "Можно в рассрочку?", ruleKey: "postpay_request", percent: null },
      tenantId,
    );

    expect(decision.allowed).toBe(false);
  });

  it("возврат средств всегда уходит менеджеру", async () => {
    const decision = await check(
      { text: "Нужен возврат денег", ruleKey: "refund_request", percent: null },
      tenantId,
    );

    expect(decision.allowed).toBe(false);
  });
});

describe("полномочия агента: правило арендатора перекрывает встроенное", () => {
  it("правило арендатора с порогом 10% разрешает скидку 7%", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'allow', 'Порог арендатора 10%', 10, now())`,
      [tenantId],
    );

    const decision = await check(
      { text: "Какую скидку 7% вы дадите?", ruleKey: "discount_request", percent: 7 },
      tenantId,
    );

    expect(decision.allowed).toBe(true);

    await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  });

  it("правило арендатора с порогом 10% всё равно запрещает скидку 15%", async () => {
    await testPool().query(
      `INSERT INTO policy_rules (tenant_id, rule_key, action, note, threshold, valid_from)
       VALUES ($1, 'discount_request', 'allow', 'Порог арендатора 10%', 10, now())`,
      [tenantId],
    );

    const decision = await check(
      { text: "Какую скидку 15% вы дадите?", ruleKey: "discount_request", percent: 15 },
      tenantId,
    );

    expect(decision.allowed).toBe(false);

    await testPool().query("DELETE FROM policy_rules WHERE tenant_id = $1", [tenantId]);
  });
});
