"use client";

import { useState } from "react";
import type { CapabilityDescriptor } from "@/modules/agent-settings";

/**
 * Форма настроек агента.
 *
 * Форма собирается из реестра возможностей: каждый элемент управления
 * берётся из реестра вместе с признаком `supported` и причиной. Страница не
 * перечисляет поля вручную, поэтому «отключено в интерфейсе» и «отключено в
 * API» не могут разойтись.
 *
 * Отключённый элемент отличается не только цветом, но и атрибутом `disabled`
 * и текстовой пометкой: цвет не единственный носитель смысла (R26).
 */

export type SettingsValues = Record<string, string | number | boolean>;

export type SettingsFormProps = {
  capabilities: CapabilityDescriptor[];
  values: SettingsValues;
  /** Стандартный системный промпт: цель кнопки сброса. */
  defaultPrompt: string;
};

export function SettingsForm({
  capabilities,
  values,
  defaultPrompt,
}: SettingsFormProps) {
  const [prompt, setPrompt] = useState(String(values["system_prompt"] ?? ""));
  const [message, setMessage] = useState<string | null>(null);

  const supported = capabilities.filter((capability) => capability.supported);
  const unsupported = capabilities.filter((capability) => !capability.supported);

  return (
    <form
      className="sl-settings__form"
      action="/api/settings"
      method="post"
      onSubmit={() => setMessage(null)}
    >
      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Подключение к модели</legend>
        {supported
          .filter((capability) =>
            ["provider", "model", "endpoint"].includes(capability.key),
          )
          .map((capability) => (
            <label className="sl-settings__field" key={capability.key}>
              <span className="sl-settings__label">{capability.label}</span>
              <input
                className="sl-settings__input"
                name={capability.key}
                type={capability.control === "select" ? "text" : "text"}
                defaultValue={String(values[capability.key] ?? "")}
              />
            </label>
          ))}
        <p className="sl-settings__note">
          Ключ провайдера задан переменной окружения и в кабинете не
          редактируется: секреты в конфигурации не хранятся.
        </p>
      </fieldset>

      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Системный промпт</legend>
        <label className="sl-settings__field">
          <span className="sl-settings__label">Системный промпт</span>
          <textarea
            className="sl-settings__textarea"
            name="system_prompt"
            rows={6}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button
          className="sl-settings__secondary"
          type="button"
          onClick={() => setPrompt(defaultPrompt)}
        >
          Сбросить к умолчанию
        </button>
      </fieldset>

      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Параметры модели</legend>
        {supported
          .filter((capability) =>
            ["temperature", "max_tokens"].includes(capability.key),
          )
          .map((capability) => (
            <label className="sl-settings__field" key={capability.key}>
              <span className="sl-settings__label">{capability.label}</span>
              <input
                className="sl-settings__input"
                name={capability.key}
                type="number"
                defaultValue={Number(values[capability.key] ?? 0)}
              />
            </label>
          ))}
      </fieldset>

      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Инструменты</legend>
        {unsupported.map((capability) => (
          <div className="sl-settings__row" data-capability-row key={capability.key}>
            <label className="sl-settings__field">
              <span className="sl-settings__label">{capability.label}</span>
              <input
                className="sl-settings__input"
                name={capability.key}
                type="text"
                disabled
                data-capability={capability.key}
              />
            </label>
            <p className="sl-settings__reason">
              не реализовано — {capability.reason}
            </p>
          </div>
        ))}
      </fieldset>

      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Лимиты и безопасность</legend>
        {supported
          .filter((capability) => capability.key === "shadow_mode")
          .map((capability) => (
            <label className="sl-settings__field" key={capability.key}>
              <span className="sl-settings__label">{capability.label}</span>
              <input
                className="sl-settings__checkbox"
                name={capability.key}
                type="checkbox"
                defaultChecked={Boolean(values[capability.key])}
              />
            </label>
          ))}
        <p className="sl-settings__note">
          Маскирование персональных данных включено и отключению не подлежит.
        </p>
      </fieldset>

      <fieldset className="sl-settings__group">
        <legend className="sl-settings__legend">Песочница</legend>
        <label className="sl-settings__field">
          <span className="sl-settings__label">Вопрос для проверки</span>
          <textarea
            className="sl-settings__textarea"
            name="sandbox_text"
            rows={3}
          />
        </label>
        <button className="sl-settings__secondary" type="submit" formAction="/api/settings/sandbox">
          Запустить в песочнице
        </button>
        <p className="sl-settings__note">
          Песочница не отправляет сообщения в веб-чат и MAX, не меняет клиентские
          диалоги и не влияет на аналитику рабочего окружения.
        </p>
      </fieldset>

      {message !== null && (
        <p className="sl-settings__message" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
