/**
 * Реестр возможностей кабинета настроек.
 *
 * Единственное место, где перечислено состояние каждого элемента
 * управления: страница кабинета и маршрут `GET /api/settings` берут её отсюда,
 * поэтому «отключено в интерфейсе» и «отключено в API» не могут разойтись.
 *
 * Честность состояния важнее полноты формы: элемент, который не работает,
 * обязан быть отключён и подписан «не реализовано». Показывать рабочим
 * нельзя.
 */

export type CapabilityControl = "toggle" | "text" | "number" | "select";

export type CapabilityDescriptor = {
  /** Ключ настройки: тот же, что принимает `updateSetting`. */
  key: string;
  /** Название элемента управления в интерфейсе. */
  label: string;
  /** Поддерживается ли элемент управления. */
  supported: boolean;
  /** Причина отключения: человекочитаемый текст с пометкой «не реализовано». */
  reason: string | null;
  /** Вид элемента управления. */
  control: CapabilityControl;
};

/**
 * Реестр элементов управления.
 *
 * Поддерживаемые элементы — ровно те, у которых есть работающий потребитель:
 * `provider`/`model`/`endpoint`/`temperature`/`max_tokens` читает клиент
 * модели, `system_prompt` — ядро, `shadow_mode` — сервис режима тени
 * (`tenants.shadow_mode`, ADR-0008).
 */
export const CAPABILITIES: CapabilityDescriptor[] = [
  {
    key: "provider",
    label: "Провайдер модели",
    supported: true,
    reason: null,
    control: "select",
  },
  {
    key: "model",
    label: "Модель",
    supported: true,
    reason: null,
    control: "text",
  },
  {
    key: "endpoint",
    label: "Адрес провайдера",
    supported: true,
    reason: null,
    control: "text",
  },
  {
    key: "system_prompt",
    label: "Системный промпт",
    supported: true,
    reason: null,
    control: "text",
  },
  {
    key: "temperature",
    label: "Температура ответа",
    supported: true,
    reason: null,
    control: "number",
  },
  {
    key: "max_tokens",
    label: "Лимит токенов ответа",
    supported: true,
    reason: null,
    control: "number",
  },
  {
    key: "shadow_mode",
    label: "Режим тени",
    supported: true,
    reason: null,
    control: "toggle",
  },
  {
    key: "tools",
    label: "Инструменты агента",
    supported: false,
    reason:
      "Отключение отдельного инструмента не реализовано: ядро вызывает поиск по БЗ, каталог и проверку полномочий всегда.",
    control: "toggle",
  },
  {
    key: "skills",
    label: "Навыки (markdown)",
    supported: false,
    reason:
      "Загрузка markdown-навыков не реализовано: в проекте нет загрузчика навыков.",
    control: "toggle",
  },
  {
    key: "mcp",
    label: "MCP-подключения к внешним серверам",
    supported: false,
    reason:
      "MCP-подключения к внешним серверам (Streamable HTTP, SSE, stdio) не реализовано: в проекте нет MCP-клиента.",
    control: "toggle",
  },
  {
    key: "limits",
    label: "Лимиты и бюджет",
    supported: false,
    reason:
      "Изменение лимитов из кабинета не реализовано: лимиты задаются переменными окружения и общим модулем src/modules/limits.",
    control: "number",
  },
  {
    key: "top_p",
    label: "Top-p",
    supported: false,
    reason:
      "Параметр top_p не реализовано: клиент модели его не передаёт провайдеру.",
    control: "number",
  },
  {
    key: "seed",
    label: "Seed",
    supported: false,
    reason:
      "Параметр seed не реализовано: клиент модели его не передаёт провайдеру.",
    control: "number",
  },
  {
    key: "promises.schedule",
    label: "Отложенные обещания (email, CRM)",
    supported: false,
    reason:
      "Отправка в email и CRM не реализовано: интеграций с почтой и CRM в проекте нет.",
    control: "toggle",
  },
];

/**
 * Описание всех элементов управления.
 *
 * Функция возвращает копию реестра: вызывающий код не может изменить
 * состояние элементов управления для всех сразу.
 */
export function describeCapabilities(): CapabilityDescriptor[] {
  return CAPABILITIES.map((capability) => ({ ...capability }));
}
