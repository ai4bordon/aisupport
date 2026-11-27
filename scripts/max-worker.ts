#!/usr/bin/env node
// Воркер MAX: опрос событий бота, вызов ядра по HTTP, ответ в тот же чат.
//
// Запуск: npx tsx scripts/max-worker.ts
//
// Переменные окружения:
//   MAX_BOT_TOKEN      — токен бота (обязателен);
//   CORE_BASE_URL      — адрес ядра, по умолчанию http://127.0.0.1:3000;
//   MAX_BASE_URL       — адрес Bot API, по умолчанию https://platform-api.max.ru.
//
// Токен в логи не попадает: печатаются только коды ответов, типы событий
// и обрезанные тексты.
import { createCoreClient } from "../src/channels/max/core";
import { createMaxClient } from "../src/channels/max/client";
import { startMaxAdapter, stopMaxAdapter } from "../src/channels/max/adapter";
import { createChannelStateStore, createStatePool } from "../src/channels/max/state";
import { maskPersonalData, restoreMaskedData } from "../src/core/mask";
import { createMaskMappingStore } from "../src/core/mask-store";
import { isShadowMode, recordManagerQueue } from "../src/core/shadow-mode";
import { getTenantId } from "../src/db/tenant";

const token = process.env.MAX_BOT_TOKEN ?? "";
if (token.length === 0) {
  console.error("MAX_BOT_TOKEN не задан");
  process.exit(2);
}

const coreBaseUrl = process.env.CORE_BASE_URL ?? "http://127.0.0.1:3000";
const maxBaseUrl = process.env.MAX_BASE_URL ?? "https://platform-api.max.ru";

const core = createCoreClient({ baseUrl: coreBaseUrl });
const client = createMaxClient(token, { baseUrl: maxBaseUrl });

const logger = {
  info: (message: string) => console.log(`[${new Date().toISOString()}] ${message}`),
  warn: (message: string) => console.warn(`[${new Date().toISOString()}] ${message}`),
  error: (message: string) => console.error(`[${new Date().toISOString()}] ${message}`),
};

async function main() {
  logger.info(`Воркер MAX: ядро ${coreBaseUrl}, Bot API ${maxBaseUrl}`);

  // Сначала проверяем, что ядро живо: без него воркер не стартует.
  const health = await fetch(`${coreBaseUrl.replace(/\/+$/, "")}/api/health`).catch(() => null);
  if (!health?.ok) {
    logger.error(`Ядро не отвечает: ${coreBaseUrl}/api/health`);
    process.exit(1);
  }
  logger.info("Ядро отвечает, стартую опрос событий MAX");

  // Состояние канала живёт в базе: по нему `/api/max/status` показывает
  // состояние опроса, хотя сам опрос идёт в этом отдельном процессе.
  const statePool = createStatePool();
  const tenantId = await getTenantId();
  const state = createChannelStateStore(statePool, { tenantId });
  const maskStore = createMaskMappingStore(statePool);

  await startMaxAdapter({
    token,
    client,
    runAgent: (input) => core.runAgent(input),
    // ПД маскируются до вызова ядра: модель получает только метки.
    // Соответствия меток накапливаются по диалогу в базе, поэтому одно
    // и то же значение в разных диалогах получает независимые метки, а
    // один и тот же человек в двух сообщениях — одну.
    mask: async (text, conversationId) => {
      const known = await maskStore.load(conversationId);
      const result = maskPersonalData(text, { mapping: known });
      await maskStore.save(conversationId, result.mapping);
      return result;
    },
    // Метки в ответе ядра заменяются исходными значениями по таблице
    // соответствий диалога: клиент получает свои же данные обратно.
    restore: async (text, conversationId) => {
      const mapping = await maskStore.load(conversationId);
      return restoreMaskedData(text, mapping);
    },
    state,
    // Режим тени — одна настройка на оба канала: она живёт в
    // `tenants.shadow_mode` и читается на каждое событие. Кэш в процессе
    // сделал бы отключение недействующим до перезапуска.
    shadowMode: async () => isShadowMode(statePool, tenantId),
    // В режиме тени результат не отправляется клиенту, а попадает в очередь
    // менеджера: тот же общий сервис, что и в веб-чате. Причина эскалации не
    // переписывается — наличие черновика в очереди не превращает эскалацию в
    // разрешение отправить ответ клиенту.
    recordShadowDraft: async (record) =>
      recordManagerQueue(statePool, {
        tenantId,
        conversationId: record.conversationId,
        channel: record.channel,
        reason: record.reason,
        summary: record.summary,
        result: record.result,
        draft: record.result,
        sources: record.sources,
        traceRef: record.traceRef,
      }),
    logger,
  });

  logger.info("Опрос запущен: жду message_created");
}

const shutdown = async () => {
  logger.info("Останавливаю опрос");
  await stopMaxAdapter().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
