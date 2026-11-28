"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ManagerCard,
  ManagerEmptyState,
  ManagerErrorState,
  ManagerLoading,
} from "@/app/manager/components";
// Общий модуль разметки: виджет, песочница и страница агента показывают
// ответ одинаково. Второго рендерера не появляется.
import { Markdown } from "@/app/components/markdown";
// Тип берётся из модуля настроек: свой дубликат разошёлся бы с реестром
// возможностей при правке модуля. Импорт только типа — в браузер модуль не
// попадает (он тянет драйвер базы).
import type { CapabilityDescriptor } from "@/modules/agent-settings";

/**
 * Клиентская часть раздела кабинета менеджера «Агент».
 *
 * Раздел переносит готовую страницу настроек среза 08
 * (`src/app/settings/**`) в кабинет менеджера и переводит её на общие
 * компоненты кабинета: `ManagerCard` (карточка раздела), `ManagerLoading`
 * (загрузка), `ManagerErrorState` (ошибка) и `ManagerEmptyState` (пусто).
 *
 * Источники данных — маршруты среза 08, они в `main` уже есть:
 * - `GET /api/settings` — текущая версия конфигурации и реестр возможностей;
 * - `PUT /api/settings` — изменение одной поддерживаемой настройки;
 * - `GET /api/settings/history` — история тестовых сессий;
 * - `POST /api/settings/sandbox` — изолированный тестовый запуск;
 * - `GET /audit` — аудит изменений настроек.
 *
 * Форма собирается из реестра возможностей, а не из ручного списка полей:
 * состояние элемента управления в интерфейсе и в API не может разойтись.
 *
 * Схема сохранения одна на весь раздел: поля только правятся, а применение
 * делает единственная кнопка «Сохранить» в панели сверху. Пока изменения не
 * сохранены, панель прямо пишет «Есть несохранённые изменения» — молчащая
 * кнопка без признака оставила бы менеджера в догадках, применён его правки
 * или нет.
 *
 * Нереализованные элементы управления (supported: false) собраны в один
 * свёрнутый блок «В следующих версиях»: они не занимают весь экран, но
 * причина отключения у каждого остаётся видна.
 */

/**
 * Элемент управления из реестра возможностей модуля `agent-settings`.
 *
 * Тип переиспользуется из модуля: список полей и их состояние не должны
 * разойтись с тем, что отдаёт `GET /api/settings`.
 */
export type AgentCapability = CapabilityDescriptor;

/** Ответ `GET /api/settings`: конфигурация и реестр возможностей. */
type SettingsPayload = {
  version: number;
  provider: string;
  model: string;
  endpoint: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  shadow_mode: boolean;
  created_at: string;
  capabilities: AgentCapability[];
};

/** Сессия тестов из истории `GET /api/settings/history`. */
type HistorySession = {
  session_id: string;
  settings_version: number;
  settings_snapshot: Record<string, unknown>;
  request_text_masked: string;
  result: {
    outcome: string;
    answer: string;
    grade: string;
    sources: Array<{ kind?: string; id?: string; title?: string; location?: string | null }>;
  };
  tokens_in: number;
  tokens_out: number;
  cost_rub: string | number;
  actor: string;
  created_at: string;
};

/** Запись аудита изменений из `GET /audit`. */
type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  key: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
};

/** Ответ песочницы `POST /api/settings/sandbox`. */
type SandboxResult = {
  session_id: string;
  settings_version: number;
  outcome: string;
  grade: string;
  answer: string;
  tokens_in: number;
  tokens_out: number;
  cost_rub: string | number;
};

/** Состояние песочницы: ожидание, запуск, результат или отказ. */
type SandboxState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SandboxResult }
  | { kind: "failed"; message: string };

/** Ключи настроек блока «Подключение к модели». */
const CONNECTION_KEYS = ["provider", "model", "endpoint"];

/** Ключи настроек блока «Параметры модели». */
const PARAMETER_KEYS = ["temperature", "max_tokens"];

/** Ключ системного промпта: у него отдельный блок с редактором. */
const PROMPT_KEY = "system_prompt";

/** Ключ режима тени: единственный источник — `tenants.shadow_mode`. */
const SHADOW_KEY = "shadow_mode";

/** Оценка тестовой сессии: человекочитаемая подпись. */
const GRADE_LABELS: Record<string, string> = {
  ok: "подтверждён",
  no_confirmed_source: "нет подтверждённого источника",
  invalid: "нарушение правил ответа",
};

/** Итог тестовой сессии: человекочитаемая подпись. */
const OUTCOME_LABELS: Record<string, string> = {
  respond: "ответ",
  escalate: "передача менеджеру",
};

/**
 * Сумма в рублях: два знака после запятой и знак валюты.
 *
 * Формат один на всю таблицу: сравнивать затраты в разной записи неудобно.
 */
function formatCost(value: string | number): string {
  const amount = Number(value);
  return `${amount.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/** Дата и время: коротко и по русски. */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/**
 * Текст ошибки из тела ответа маршрута.
 *
 * Берётся только поле `error.message` контракта: коды и детали ответа в
 * интерфейсе не показываются.
 */
async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Тело ответа не разобралось — сообщаем общий текст.
  }
  return fallback;
}

/** Значение настройки для JSON-тела `PUT /api/settings`. */
function settingValue(key: string, raw: string): string | number {
  if (key === "temperature" || key === "max_tokens") {
    return Number(raw);
  }
  return raw;
}

/**
 * Ключи, значения которых отличаются от сохранённых.
 *
 * Ключ считается изменённым, только если сервер его отдавал: поле, которого
 * нет в сохранённой конфигурации, сохранять нельзя — запрос уйдёт с
 * неизвестным ключом.
 */
function changedKeysOf(
  values: Record<string, string>,
  savedValues: Record<string, string>,
): string[] {
  return Object.keys(values).filter(
    (key) => savedValues[key] !== undefined && values[key] !== savedValues[key],
  );
}

export type AgentClientProps = {
  /** Стандартный системный промпт: цель кнопки сброса. */
  defaultPrompt: string;
};

/**
 * Раздел «Агент»: настройки агента, песочница, история и аудит.
 *
 * Состояния явные: загрузка, ошибка и пусто показаны отдельными блоками,
 * а не пустой страницей.
 */
export function AgentClient({ defaultPrompt }: AgentClientProps) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySession[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  /** Значения полей формы: то, что менеджер видит и правит. */
  const [values, setValues] = useState<Record<string, string>>({});
  /** Значения, которые сервер уже сохранил: с ними сравнивается форма. */
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Результат действия над формой, не связанного с сохранением. */
  const [promptNotice, setPromptNotice] = useState<string | null>(null);

  const [sandboxText, setSandboxText] = useState("");
  const [sandbox, setSandbox] = useState<SandboxState>({ kind: "idle" });
  const sandboxInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSettings(): Promise<void> {
      try {
        const response = await fetch("/api/settings", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as SettingsPayload;
        setSettings(payload);
        const loaded = {
          provider: payload.provider,
          model: payload.model,
          endpoint: payload.endpoint,
          system_prompt: payload.system_prompt,
          temperature: String(payload.temperature),
          max_tokens: String(payload.max_tokens),
        };
        setValues(loaded);
        setSavedValues(loaded);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setSettingsError("Не удалось загрузить настройки агента");
      }
    }

    async function loadHistory(): Promise<void> {
      try {
        const response = await fetch("/api/settings/history?limit=20", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { sessions?: unknown };
        if (!Array.isArray(payload.sessions)) {
          throw new Error("Неожиданный формат ответа");
        }
        setHistory(payload.sessions as HistorySession[]);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setHistoryError("Не удалось загрузить историю тестовых сессий");
      }
    }

    async function loadAudit(): Promise<void> {
      try {
        const response = await fetch("/audit?limit=20", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { entries?: unknown };
        if (!Array.isArray(payload.entries)) {
          throw new Error("Неожиданный формат ответа");
        }
        setAudit(payload.entries as AuditEntry[]);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setAuditError("Не удалось загрузить аудит изменений");
      }
    }

    void loadSettings();
    void loadHistory();
    void loadAudit();

    return () => controller.abort();
  }, []);

  /**
   * Сохранение всех изменённых настроек одной кнопкой.
   *
   * `PUT /api/settings` принимает одну настройку за раз, поэтому изменённые
   * ключи сохраняются по очереди. Уже сохранённые ключи перестают считаться
   * изменёнными сразу — если запрос упал на середине, видно, что именно
   * осталось несохранённым.
   */
  const saveChanges = useCallback(async (): Promise<void> => {
    const changed = changedKeysOf(values, savedValues);
    if (changed.length === 0 || saving) {
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    setSaveError(null);
    try {
      for (const key of changed) {
        const raw = values[key] ?? "";
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key,
            value: settingValue(key, raw),
            actor: "manager",
          }),
        });
        if (!response.ok) {
          setSaveError(
            await readError(response, "Настройки сохранить не удалось"),
          );
          return;
        }
        const payload = (await response.json()) as { version?: number };
        setSettings((current) =>
          current && typeof payload.version === "number"
            ? { ...current, version: payload.version }
            : current,
        );
        setSavedValues((current) => ({ ...current, [key]: raw }));
      }
      setSaveMessage("Настройки сохранены");
    } catch {
      setSaveError("Сервер не ответил. Проверьте соединение и попробуйте снова.");
    } finally {
      setSaving(false);
    }
  }, [savedValues, saving, values]);

  const runSandbox = useCallback(async (): Promise<void> => {
    const text = sandboxText.trim();
    if (text.length === 0) {
      setSandbox({ kind: "failed", message: "Вопрос для проверки не задан" });
      return;
    }
    setSandbox({ kind: "running" });
    try {
      const response = await fetch("/api/settings/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, actor: "manager" }),
      });
      if (!response.ok) {
        setSandbox({
          kind: "failed",
          message: await readError(response, "Песочница недоступна"),
        });
        return;
      }
      const payload = (await response.json()) as SandboxResult;
      setSandbox({ kind: "done", result: payload });
    } catch {
      setSandbox({
        kind: "failed",
        message: "Сервер не ответил. Проверьте соединение и попробуйте снова.",
      });
    }
  }, [sandboxText]);

  const repeatSession = useCallback((question: string): void => {
    setSandboxText(question);
    setSandbox({ kind: "idle" });
    sandboxInputRef.current?.focus();
  }, []);

  /**
   * Сброс системного промпта к стандартному.
   *
   * Значение только ставится в форму: применение — отдельным действием
   * «Сохранить». Менеджер видит об этом прямо из сообщения.
   */
  const resetPrompt = useCallback((): void => {
    // Сброс меняет значение в форме, только если оно отличалось от
    // стандартного: иначе сохранять нечего, и сообщение об этом честнее.
    const wasChanged = values[PROMPT_KEY] !== defaultPrompt;
    setValues((current) => ({
      ...current,
      [PROMPT_KEY]: defaultPrompt,
    }));
    setSaveMessage(null);
    setSaveError(null);
    setPromptNotice(
      wasChanged
        ? "Промпт сброшен к стандартному — сохраните, чтобы применить"
        : "Промпт уже стандартный — сохранять нечего",
    );
  }, [defaultPrompt, values]);

  if (settingsError !== null) {
    return (
      <main className="sl-agent-page" aria-label="Настройки агента">
        <ManagerErrorState
          title="Не удалось загрузить настройки агента"
          description="Проверьте соединение с сервером и обновите страницу. Кабинет закрыт до входа по коду доступа — войдите и попробуйте снова."
        />
      </main>
    );
  }

  if (settings === null) {
    return (
      <main className="sl-agent-page" aria-label="Настройки агента">
        <ManagerLoading label="Загружаем настройки агента" />
      </main>
    );
  }

  const capabilities = Array.isArray(settings.capabilities)
    ? settings.capabilities
    : [];
  const supported = capabilities.filter((capability) => capability.supported);
  const unsupported = capabilities.filter((capability) => !capability.supported);
  const connection = supported.filter((capability) =>
    CONNECTION_KEYS.includes(capability.key),
  );
  const parameters = supported.filter((capability) =>
    PARAMETER_KEYS.includes(capability.key),
  );
  const promptCapability = supported.find(
    (capability) => capability.key === PROMPT_KEY,
  );
  const shadowCapability = supported.find(
    (capability) => capability.key === SHADOW_KEY,
  );
  const other = supported.filter(
    (capability) =>
      !CONNECTION_KEYS.includes(capability.key) &&
      !PARAMETER_KEYS.includes(capability.key) &&
      capability.key !== PROMPT_KEY &&
      capability.key !== SHADOW_KEY,
  );

  const changedKeys = changedKeysOf(values, savedValues);
  const hasUnsaved = changedKeys.length > 0;
  const saveState = hasUnsaved
    ? "Есть несохранённые изменения"
    : "Все изменения сохранены";

  return (
    <main className="sl-agent-page" aria-label="Настройки агента">
      <header className="sl-agent-header">
        <p className="sl-agent-eyebrow">Кабинет менеджера</p>
        <h1 className="sl-agent-title">Настройки агента</h1>
        <p className="sl-agent-lead">
          Конфигурация версии {settings.version}. Изменение действует на
          следующий новый диалог: уже открытый диалог продолжает работать на
          прежней версии.
        </p>
      </header>

      <section className="sl-agent-savebar" aria-label="Сохранение настроек">
        <div className="sl-agent-savebar__status">
          <p className="sl-agent-savebar__state" role="status">
            {saveState}
          </p>
          <p className="sl-agent-savebar__hint">
            {hasUnsaved
              ? `Изменено полей: ${changedKeys.length}. Нажмите «Сохранить», чтобы применить изменения.`
              : "Поля соответствуют сохранённой конфигурации."}
          </p>
          {saveMessage !== null ? (
            <p className="sl-agent-savebar__message">{saveMessage}</p>
          ) : null}
        </div>
        <button
          className="sl-agent-button sl-agent-button--primary"
          type="button"
          disabled={!hasUnsaved || saving}
          onClick={() => {
            void saveChanges();
          }}
        >
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </section>

      {saveError !== null ? (
        <p className="sl-agent-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <ManagerCard
        id="agent-connection"
        title="Подключение к модели"
        description="Провайдер, модель и адрес, по которым агент обращается к модели."
      >
        {connection.map((capability) => (
          <AgentField
            key={capability.key}
            capability={capability}
            value={values[capability.key] ?? ""}
            disabled={saving}
            onChange={(next) =>
              setValues((current) => ({ ...current, [capability.key]: next }))
            }
          />
        ))}
        <p className="sl-agent-note">
          Ключ провайдера задан переменной окружения и в кабинете не
          редактируется: секреты в конфигурации не хранятся.
        </p>
      </ManagerCard>

      <ManagerCard
        id="agent-prompt"
        title="Системный промпт"
        description="Правила, по которым агент отвечает клиенту."
      >
        {promptCapability ? (
          <AgentField
            capability={promptCapability}
            value={values[promptCapability.key] ?? ""}
            multiline
            labelText="Текст системного промпта"
            disabled={saving}
            onChange={(next) =>
              setValues((current) => ({
                ...current,
                [promptCapability.key]: next,
              }))
            }
          />
        ) : (
          <p className="sl-agent-note">
            Редактор системного промпта недоступен: настройка не поддерживается
            этой версией модуля.
          </p>
        )}
        <button
          className="sl-agent-button"
          type="button"
          onClick={resetPrompt}
        >
          Сбросить к стандартному
        </button>
        {promptNotice !== null ? (
          <p className="sl-agent-message" aria-live="polite">
            {promptNotice}
          </p>
        ) : null}
      </ManagerCard>

      <ManagerCard
        id="agent-parameters"
        title="Параметры модели"
        description="Температура ответа и предел длины ответа."
      >
        {parameters.map((capability) => (
          <AgentField
            key={capability.key}
            capability={capability}
            value={values[capability.key] ?? ""}
            numeric
            disabled={saving}
            onChange={(next) =>
              setValues((current) => ({ ...current, [capability.key]: next }))
            }
          />
        ))}
        {other.map((capability) => (
          <AgentField
            key={capability.key}
            capability={capability}
            value={values[capability.key] ?? ""}
            disabled={saving}
            onChange={(next) =>
              setValues((current) => ({ ...current, [capability.key]: next }))
            }
          />
        ))}
      </ManagerCard>

      <ManagerCard
        id="agent-upcoming"
        title="В следующих версиях"
        description="Элементы управления, которые в проекте не реализованы. Пока ими пользоваться нельзя — причина указана у каждого."
      >
        {unsupported.length === 0 ? (
          <p className="sl-agent-note">Нереализованных элементов управления нет.</p>
        ) : (
          <details className="sl-agent-upcoming">
            <summary className="sl-agent-upcoming__summary">
              {`Показать недоступные элементы (${unsupported.length})`}
            </summary>
            <ul className="sl-agent-upcoming__list">
              {unsupported.map((capability) => (
                <li
                  className="sl-agent-upcoming__item"
                  key={capability.key}
                  data-capability-item={capability.key}
                >
                  <p className="sl-agent-upcoming__name">
                    <span>{capability.label}</span>
                    <span className="sl-agent-badge">не реализовано</span>
                  </p>
                  <p className="sl-agent-reason">{capability.reason}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </ManagerCard>

      <ManagerCard
        id="agent-limits"
        title="Лимиты и безопасность"
        description="Общее состояние режима тени и маскирование персональных данных."
      >
        <div className="sl-agent-field">
          <label className="sl-agent-label" htmlFor="agent-shadow-mode">
            <span>{shadowCapability?.label ?? "Режим тени"}</span>
          </label>
          <input
            className="sl-agent-checkbox"
            id="agent-shadow-mode"
            data-capability={SHADOW_KEY}
            type="checkbox"
            checked={settings.shadow_mode}
            disabled
            readOnly
          />
          <p className="sl-agent-state">
            {settings.shadow_mode ? "включён" : "выключен"}
          </p>
          <p className="sl-agent-note">
            Режим тени хранится в настройках арендатора и переключается вне
            кабинета: единственный источник истины — <code>tenants.shadow_mode</code>,
            иначе веб-чат и MAX показали бы разное состояние.
          </p>
        </div>
        <p className="sl-agent-note">
          Маскирование персональных данных включено и отключению не подлежит.
        </p>
      </ManagerCard>

      <ManagerCard
        id="agent-sandbox"
        title="Песочница"
        description="Проверка настроек на одном вопросе, без клиента."
      >
        <div className="sl-agent-field">
          <label className="sl-agent-label" htmlFor="agent-sandbox-text">
            <span>Вопрос для проверки</span>
          </label>
          <textarea
            className="sl-agent-textarea"
            id="agent-sandbox-text"
            ref={sandboxInputRef}
            rows={3}
            value={sandboxText}
            onChange={(event) => setSandboxText(event.target.value)}
          />
        </div>
        <button
          className="sl-agent-button sl-agent-button--primary"
          type="button"
          disabled={sandbox.kind === "running"}
          onClick={() => {
            void runSandbox();
          }}
        >
          {sandbox.kind === "running" ? "Запускаем…" : "Запустить в песочнице"}
        </button>
        <p className="sl-agent-note">
          Песочница не отправляет сообщения в веб-чат и MAX, не меняет клиентские
          диалоги и не влияет на аналитику рабочего окружения.
        </p>

        {sandbox.kind === "running" ? (
          <p className="sl-agent-running" role="status">
            Запрос отправлен в песочницу — ждём ответ агента…
          </p>
        ) : null}

        {sandbox.kind === "failed" ? (
          <p className="sl-agent-error" role="alert">
            {sandbox.message}
          </p>
        ) : null}

        {sandbox.kind === "done" ? (
          <div className="sl-agent-sandbox-result">
            <div className="sl-agent-sandbox-answer">
              <Markdown source={sandbox.result.answer} />
            </div>
            <p className="sl-agent-note">
              Оценка: {GRADE_LABELS[sandbox.result.grade] ?? sandbox.result.grade}
              {" · "}
              Итог: {OUTCOME_LABELS[sandbox.result.outcome] ?? sandbox.result.outcome}
              {" · "}
              Версия конфигурации: {sandbox.result.settings_version}
              {" · "}
              Токены: {sandbox.result.tokens_in} / {sandbox.result.tokens_out}
              {" · "}
              Затраты: {formatCost(sandbox.result.cost_rub)}
            </p>
          </div>
        ) : null}
      </ManagerCard>

      <ManagerCard
        id="agent-history"
        title="История тестовых сессий"
        description="Каждая тестовая сессия: конфигурация, оценка ответа, токены и затраты."
      >
        {historyError !== null ? (
          <ManagerErrorState
            title="Не удалось загрузить историю тестовых сессий"
            description="История появится после обновления страницы."
          />
        ) : history === null ? (
          <ManagerLoading label="Загружаем историю тестовых сессий" />
        ) : history.length === 0 ? (
          <ManagerEmptyState
            title="Тестовых сессий пока нет"
            description="Запустите вопрос в песочнице — сессия появится здесь."
          />
        ) : (
          <>
            <div
              className="sl-agent-table-scroll"
              role="region"
              aria-label="Прокручиваемая таблица истории тестовых сессий"
              tabIndex={0}
            >
              <table className="sl-agent-table">
                <caption className="sl-agent-table__caption">
                  Последние тестовые сессии
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Версия</th>
                    <th scope="col">Оценка</th>
                    <th scope="col">Токены</th>
                    <th scope="col">Затраты</th>
                    <th scope="col">Модель</th>
                    <th scope="col">Вопрос</th>
                    <th scope="col">Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((session) => (
                    <tr key={session.session_id}>
                      <td>{session.settings_version}</td>
                      <td>{GRADE_LABELS[session.result.grade] ?? session.result.grade}</td>
                      <td>{`${session.tokens_in} / ${session.tokens_out}`}</td>
                      <td>{formatCost(session.cost_rub)}</td>
                      <td>{String(session.settings_snapshot["model"] ?? "—")}</td>
                      <td>{session.request_text_masked}</td>
                      <td>
                        <button
                          className="sl-agent-button"
                          type="button"
                          aria-label="Повторить тестовую сессию"
                          onClick={() => {
                            repeatSession(session.request_text_masked);
                          }}
                        >
                          Повторить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sl-agent-note sl-agent-scroll-hint">
              Таблицу можно прокручивать вбок: на узком экране колонки не
              сжимаются и остаются читаемыми.
            </p>
          </>
        )}
      </ManagerCard>

      <ManagerCard
        id="agent-audit"
        title="Аудит изменений"
        description="Кто, что и когда изменил в настройках агента."
      >
        {auditError !== null ? (
          <ManagerErrorState
            title="Не удалось загрузить аудит изменений"
            description="Журнал появится после обновления страницы."
          />
        ) : audit === null ? (
          <ManagerLoading label="Загружаем аудит изменений" />
        ) : audit.length === 0 ? (
          <ManagerEmptyState
            title="Изменений пока не было"
            description="Первая запись появится после сохранения настройки."
          />
        ) : (
          <>
            <div
              className="sl-agent-table-scroll"
              role="region"
              aria-label="Прокручиваемая таблица аудита изменений"
              tabIndex={0}
            >
              <table className="sl-agent-table">
                <caption className="sl-agent-table__caption">Последние изменения</caption>
                <thead>
                  <tr>
                    <th scope="col">Кто</th>
                    <th scope="col">Что</th>
                    <th scope="col">До</th>
                    <th scope="col">После</th>
                    <th scope="col">Когда</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.actor}</td>
                      <td>{entry.key ?? entry.entity}</td>
                      <td>{JSON.stringify(entry.before)}</td>
                      <td>{JSON.stringify(entry.after)}</td>
                      <td>{formatDate(entry.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sl-agent-note sl-agent-scroll-hint">
              Таблицу можно прокручивать вбок: на узком экране колонки не
              сжимаются и остаются читаемыми.
            </p>
          </>
        )}
      </ManagerCard>
    </main>
  );
}

/**
 * Поле настройки: подпись и элемент управления.
 *
 * Подпись связана с полем через `htmlFor`/`id`, а не обёрткой: иначе текст
 * кнопки попал бы в доступное имя поля.
 *
 * Кнопки сохранения у поля нет: применение изменений делает одна кнопка
 * «Сохранить» в панели сверху раздела.
 */
function AgentField({
  capability,
  value,
  numeric = false,
  multiline = false,
  disabled = false,
  labelText,
  onChange,
}: {
  capability: AgentCapability;
  value: string;
  numeric?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  /** Своя подпись поля, когда имя из реестра совпадает с заголовком блока. */
  labelText?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `agent-${capability.key}`;

  return (
    <div className="sl-agent-field">
      <label className="sl-agent-label" htmlFor={inputId}>
        <span>{labelText ?? capability.label}</span>
      </label>
      {multiline ? (
        <textarea
          className="sl-agent-textarea"
          id={inputId}
          name={capability.key}
          rows={6}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="sl-agent-input"
          id={inputId}
          name={capability.key}
          type={numeric ? "number" : "text"}
          step={numeric ? "0.1" : undefined}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
