import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";

import { Markdown, parseInline, parseMarkdown } from "@/app/components/markdown";

/**
 * Безопасный рендер markdown в ответе агента.
 *
 * Регрессия живьёма (UX-аудит 28.11): ответы приходили с `**жирным**`
 * и незакрытыми списками — вёрстка выглядела сломанной, хотя текст по
 * смыслу был хорошим.
 *
 * Разметка приходит из ответа агента, то есть это данные, а не код:
 * подстановка через `dangerouslySetInnerHTML` выполнила бы произвольный
 * скрипт в браузере клиента. Здесь разметка превращается в
 * React-элементы.
 */

describe("рендер markdown в ответе агента", () => {
  it("показывает жирный текст без звёздочек", () => {
    render(createElement(Markdown, { source: "Стоимость **5000 рублей**" }));

    const strong = screen.getByText("5000 рублей");
    expect(strong.tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
  });

  it("показывает курсив без звёздочек", () => {
    render(createElement(Markdown, { source: "*на 12 месяцев*" }));

    const em = screen.getByText("на 12 месяцев");
    expect(em.tagName).toBe("EM");
  });

  it("разбирает маркированный список", () => {
    render(
      createElement(Markdown, {
        source: "Способы оплаты:\n- оплата с баланса\n- оплата картой",
      }),
    );

    expect(screen.getByText("оплата с баланса").tagName).toBe("LI");
    expect(screen.getByText("оплата картой").tagName).toBe("LI");
  });

  it("разбирает нумерованный список", () => {
    render(
      createElement(Markdown, {
        source: "1. Оплатить счёт\n2. Выбрать способ",
      }),
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.parentElement?.tagName).toBe("OL");
  });

  it("разбирает заголовок", () => {
    render(createElement(Markdown, { source: "### Оплата подписки" }));

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "Оплата подписки",
    );
  });

  it("делает ссылку кликабельной при безопасном адресе", () => {
    render(
      createElement(Markdown, {
        source: "Подробнее: [инструкция](https://store.softline.ru/test/)",
      }),
    );

    const link = screen.getByRole("link", { name: "инструкция" });
    expect(link.getAttribute("href")).toBe("https://store.softline.ru/test/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("небезопасный адрес остаётся текстом", () => {
    render(
      createElement(Markdown, {
        source: "Подробнее: [клик](javascript:alert(1))",
      }),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Подробнее/)).toBeInTheDocument();
  });

  it("не выполняет html из ответа: разметка остаётся текстом", () => {
    render(
      createElement(Markdown, {
        source: "<img src=x onerror=\"alert(1)\">",
      }),
    );

    // Элемента с обработчиком в разметке нет: html не разбирается.
    expect(document.querySelector("img")).toBeNull();
  });

  it("пустой ответ не ломает разметку", () => {
    render(createElement(Markdown, { source: "" }));
    expect(document.body.textContent).toBe("");
  });

  it("разбирает блоки: абзацы, заголовки и списки", () => {
    const nodes = parseMarkdown(
      "Вступление\n\n### Заголовок\n\n- пункт\n\nФинал",
    );

    expect(nodes.map((node) => node.kind)).toEqual([
      "paragraph",
      "heading",
      "list",
      "paragraph",
    ]);
  });

  it("встроенная разметка разбирается на части", () => {
    const parts = parseInline("**жирный** и *курсив*");

    expect(parts.map((part) => part.kind)).toEqual(["bold", "text", "italic"]);
  });
});
