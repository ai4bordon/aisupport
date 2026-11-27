"use client";

import { useState } from "react";

/**
 * Вкладка «Веб-чат»: собственный виджет в iframe и сниппет встраивания.
 *
 * Виджет встраивается с того же домена (`/widget`), поэтому cookie доступа
 * стенда работает и внутри кадра, и клиентский код отдельно не передаётся.
 */
export function ChatTab() {
  return (
    <>
      <section className="sl-start__card">
        <div className="sl-start__row sl-start__row-between">
          <h2 className="sl-start__card-title">Виджет чата на вашем сайте</h2>
          <a
            className="sl-start__link"
            href="/widget"
            target="_blank"
            rel="noreferrer"
          >
            Открыть виджет отдельно
          </a>
        </div>
        <p className="sl-start__card-lead">
          Тот же виджет, что и на сайте клиента: агент отвечает по базе знаний, а
          сложный случай передаёт менеджеру. Код клиента в виджете не нужен — он
          проверяется на сервере.
        </p>
        <iframe
          className="sl-start__widget"
          src="/widget"
          title="Виджет чата ИИ-агента поддержки"
        />
      </section>

      <EmbedSnippet />
    </>
  );
}

/**
 * Блок «Встроить на сайт клиента» с готовым сниппетом.
 *
 * Сниппет — одна строка подключения и контейнер: ровно то, что клиент
 * вставляет в свою страницу. Копирование идёт через буфер обмена, а если он
 * недоступен (нет разрешения, небезопасный контекст) — текст выделяется для
 * копирования вручную, и об этом честно сказано.
 */
function EmbedSnippet() {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const snippet = `<script src="https://support.softline.ru/widget.js" async></script>\n<div id="softline-support"></div>`;

  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard) {
        setState("manual");
        return;
      }
      await navigator.clipboard.writeText(snippet);
      setState("copied");
    } catch {
      setState("manual");
    }
  }

  return (
    <section className="sl-start__card">
      <div className="sl-start__row sl-start__row-between">
        <h2 className="sl-start__card-title">Встроить на сайт клиента</h2>
        <button
          className="sl-start__button"
          type="button"
          onClick={() => {
            void copy();
          }}
        >
          Скопировать
        </button>
      </div>
      <p className="sl-start__card-lead">
        Две строки в код страницы клиента — виджет появится в правом нижнем
        углу и заработает на том же ядре, что и этот стенд.
      </p>
      <textarea
        className="sl-start__snippet"
        readOnly
        aria-label="Сниппет для встраивания виджета"
        value={snippet}
        onFocus={(event) => {
          if (state === "manual") event.currentTarget.select();
        }}
      />
      <p className="sl-start__note" role="status">
        {state === "copied" && "Сниппет скопирован в буфер обмена."}
        {state === "manual" &&
          "Буфер обмена недоступен — выделите текст в поле и скопируйте вручную."}
        {state === "idle" &&
          "Сниппет содержит только адрес виджета: ключи и коды в нём нет."}
      </p>
    </section>
  );
}
