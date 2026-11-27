/**
 * Контекст классификатора при подборе (регрессия второго хода).
 *
 * Ответ на уточняющий вопрос («бюджета нет, инфраструктура своя») не
 * содержит названия продукта, и без контекста подбора классификатор относил
 * его к `out_of_scope`: запрос уходил в базу знаний вместо каталога, ответ
 * называл число, которого нет в источниках, и второй ход падал с 422.
 */

import { describe, expect, it } from "vitest";

import { classifierContext } from "@/core/intents";

describe("контекст классификатора при подборе", () => {
  it("подбор по названному продукту даёт контекст", () => {
    const context = classifierContext({
      discovery: null,
      productQuery: "mdaemon security gateway",
      domain: null,
      quantity: 50,
    });

    expect(context).toContain("mdaemon security gateway");
  });

  it("подбор по предметной области даёт контекст", () => {
    // Регрессия: подбор по задаче не заполняет `discovery`, и контекст
    // считался пустым — ответ на уточняющий вопрос уходил в базу знаний.
    const context = classifierContext({
      discovery: null,
      productQuery: null,
      domain: "email",
      quantity: 50,
    });

    expect(context).not.toBeNull();
    expect(context).toContain("50");
  });

  it("подбор по описанной задаче даёт контекст с задачей", () => {
    const context = classifierContext({
      discovery: "защита почты",
      productQuery: null,
      domain: "email",
      quantity: 50,
    });

    expect(context).toContain("защита почты");
  });

  it("диалог без подбора контекста не даёт", () => {
    const context = classifierContext({
      discovery: null,
      productQuery: null,
      domain: null,
      quantity: null,
    });

    expect(context).toBeNull();
  });
});
