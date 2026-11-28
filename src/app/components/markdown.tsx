import React from "react";

import { safeSourceHref } from "@/core/safe-link";

/**
 * Безопасный рендер markdown в React.
 *
 * Ответ агента приходит с markdown-разметкой: `**жирный**`, списки,
 * заголовки. Раньше виджет показывал сырой текст, и в ответе было видно
 * `**жирный**` и незакрытые списки — вёрстка выглядела сломанной, хотя
 * текст по смыслу был хорошим.
 *
 * Почему не `dangerouslySetInnerHTML`: разметка ответа — это данные, а не
 * код. Через неё можно было бы выполнить произвольный скрипт в браузере
 * клиента. Здесь разметка превращается в React-элементы: неизвестное
 * показывается как текст, ничего не исполняется.
 *
 * Поддерживается набор, который встречается в ответах агента:
 * - `**жирный**` и `*курсив*`;
 * - строки списка `- пункт` и `1. пункт`;
 * - заголовки `### Текст`;
 * - ссылки `[текст](адрес)` — только `http` и `https`, иначе текст;
 * - переносы строк и абзацы.
 *
 * Модуль общий: виджет, песочница и страница агента показывают ответы
 * одинаково. Второго рендерера не появляется.
 */

/** Узел разобранного markdown. */
export type MarkdownNode =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string };

/** Встроенный фрагмент текста: либо обычный текст, либо ссылка. */
export type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * Разбор markdown на блоки.
 *
 * Блоки разбираются построчно: список, заголовок, цитата, абзац. Вложенная
 * разметка не разбирается — она показывается как текст, и это лучше, чем
 * неверная вёрстка.
 */
export function parseMarkdown(source: string): MarkdownNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: MarkdownNode[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    nodes.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Список: строки «- пункт» или «1. пункт». Пункты одного списка
    // собираются вместе, пока не встретилась другая строка.
    const bullet = /^[-*•]\s+(.*)$/u.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/u.exec(trimmed);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const text = ordered ? (numbered?.[2] ?? "") : (bullet?.[1] ?? "");
      const last = nodes[nodes.length - 1];
      if (last !== undefined && last.kind === "list" && last.ordered === ordered) {
        last.items.push(text);
      } else {
        nodes.push({ kind: "list", ordered, items: [text] });
      }
      continue;
    }

    // Заголовок: от двух до шести решёток.
    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    if (heading !== null) {
      flushParagraph();
      nodes.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        text: heading[2] ?? "",
      });
      continue;
    }

    // Цитата.
    if (trimmed.startsWith(">")) {
      flushParagraph();
      nodes.push({ kind: "quote", text: trimmed.slice(1).trim() });
      continue;
    }

    // Пустая строка заканчивает абзац.
    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return nodes;
}

/**
 * Разбор встроенной разметки: жирный, курсив и ссылки.
 *
 * Ссылка допускается только с безопасным адресом: адрес из ответа агента —
 * это данные, и схема `javascript:` выполнила бы код в браузере клиента.
 */
export function parseInline(source: string): InlinePart[] {
  const parts: InlinePart[] = [];
  // Порядок важен: сначала ссылка, потом жирный, потом курсив.
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/gu;
  let lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ kind: "text", text: source.slice(lastIndex, index) });
    }

    const [, linkText, linkTarget, boldText, italicText] = match;
    if (linkText !== undefined && linkTarget !== undefined) {
      const href = safeSourceHref(linkTarget);
      parts.push(
        href === null
          ? { kind: "text", text: linkText }
          : { kind: "link", text: linkText, href },
      );
    } else if (boldText !== undefined) {
      parts.push({ kind: "bold", text: boldText });
    } else if (italicText !== undefined) {
      parts.push({ kind: "italic", text: italicText });
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < source.length) {
    parts.push({ kind: "text", text: source.slice(lastIndex) });
  }
  return parts;
}

/**
 * React-элементы встроенной разметки.
 *
 * Жирный и курсив показываются как текст с соответствующим начертанием:
 * React-элементы собираются здесь, а не через HTML-строку.
 */
export function renderInline(source: string): React.ReactNode[] {
  return parseInline(source).map((part, index) => {
    if (part.kind === "link") {
      return (
        <a
          key={`link-${index}`}
          href={part.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part.text}
        </a>
      );
    }
    if (part.kind === "bold") {
      return <strong key={`bold-${index}`}>{part.text}</strong>;
    }
    if (part.kind === "italic") {
      return <em key={`italic-${index}`}>{part.text}</em>;
    }
    return <React.Fragment key={`text-${index}`}>{part.text}</React.Fragment>;
  });
}

/**
 * Ответ агента в разметке.
 *
 * Блоки разбираются в абзацы, заголовки, списки и цитаты; встроенная
 * разметка — в жирный, курсив и ссылки. Ничего не подставляется как HTML:
 * разметка из ответа агента остаётся текстом и React-элементами.
 */
export function Markdown({ source }: { source: string }): React.ReactNode {
  const nodes = parseMarkdown(source);
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "heading") {
          const Tag = `h${Math.min(6, Math.max(1, node.level))}` as "h1";
          return <Tag key={`block-${index}`}>{renderInline(node.text)}</Tag>;
        }
        if (node.kind === "list") {
          const items = node.items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderInline(item)}</li>
          ));
          return node.ordered ? (
            <ol key={`block-${index}`}>{items}</ol>
          ) : (
            <ul key={`block-${index}`}>{items}</ul>
          );
        }
        if (node.kind === "quote") {
          return <blockquote key={`block-${index}`}>{renderInline(node.text)}</blockquote>;
        }
        return <p key={`block-${index}`}>{renderInline(node.text)}</p>;
      })}
    </>
  );
}
