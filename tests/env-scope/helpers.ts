import { afterAll } from "vitest";

/**
 * Изоляция общего окружения между тестовыми файлами (аудит B14).
 *
 * Переменные окружения живят на уровне процесса, а воркер Vitest
 * переиспользуется между файлами. Поэтому значение, оставленное одним
 * файлом, меняло поведение следующего: соседний тест подключался к чужой
 * базе или читал чужого арендатора, и результат прогона зависел от порядка
 * файлов.
 *
 * Файл подключается как setup-файл: Vitest выполняет его заново для каждого
 * тестового файла, поэтому снимок окружения снимается перед каждым файлом и
 * возвращается после него.
 *
 * Реестр лежит в `globalThis`, а не в модуле: модуль помощника кэшируется
 * на воркер, а setup-файл пересоздаётся на каждый файл. Через `globalThis`
 * помощник всегда достаёт реестр текущего файла.
 */

/** Переменные, состояние которых не должно утекать из файла в файл. */
const MANAGED_ENV_NAMES = [
  "DATABASE_URL",
  "TENANT_SLUG",
  "ESCALATION_MODE",
  "SESSION_SECRET",
  "ACCESS_CODE",
  "MANAGER_ACCESS_CODE",
  "KB_DOCUMENTS_DIR",
  "DOCUMENTS_DIR",
  "REQUESTS_PER_MINUTE",
  "DAILY_DIALOG_LIMIT",
] as const;

/** Ключ реестра в `globalThis`. */
const REGISTRY_KEY = "__supportAgentTestEnvScope";

type EnvRegistry = {
  /** Значения переменных до начала работы текущего тестового файла. */
  pristine: Map<string, string | undefined>;
};

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: EnvRegistry;
};

function registry(): EnvRegistry {
  const scope = globalThis as GlobalWithRegistry;
  scope[REGISTRY_KEY] ??= { pristine: new Map<string, string | undefined>() };
  return scope[REGISTRY_KEY];
}

// Реестр текущего файла: setup-файл выполняется заново для каждого файла,
// поэтому значения предыдущего файла не переживают переход.
registry().pristine.clear();
for (const name of MANAGED_ENV_NAMES) {
  registry().pristine.set(name, process.env[name]);
}

/**
 * Присваивает переменную окружения на время работы текущего тестового файла.
 *
 * Исходное значение снимается при первом обращении к переменной и
 * возвращается, когда файл закончил работу.
 */
export function scopeEnv(name: string, value: string): void {
  const scope = registry();
  if (!scope.pristine.has(name)) {
    scope.pristine.set(name, process.env[name]);
  }
  process.env[name] = value;
}

afterAll(() => {
  const scope = registry();
  for (const [name, value] of scope.pristine) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  scope.pristine.clear();
});
