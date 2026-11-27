import { createMaxClient, redactToken, type MaxClient } from "./client";
import { normalizeMaxUpdate } from "./normalize";
import type {
  AgentOutcome,
  MaskPort,
  MaxStatus,
  MaxUpdate,
  NormalizedMessage,
  OutgoingCheckPort,
  RestorePort,
  ShadowQueuePort,
} from "./types";

/**
 * Адаптер канала MAX.
 *
 * Путь сообщения: событие `GET /updates` → нормализация → порт ядра
 * `runAgent` → ответ отправляется в тот же чат (`POST /messages`).
 *
 * Правила канала:
 * - отправка только при результате `respond`;
 * - в режиме тени отправки нет ни при каком результате;
 * - предел 2 сообщения в секунду на диалог;
 * - повторное событие не создаёт второе обращение и второй ответ;
 * - токен в журналах и ошибках не появляется.
 */

/** Порог лимита отправки: не более 2 сообщений в секунду на диалог. */
const MESSAGES_PER_SECOND = 2;
const RATE_WINDOW_MS = 1000;

/** Сколько последних идентификаторов сообщений помнить для защиты от повторов. */
const SEEN_LIMIT = 1000;

export type MaxLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/** Источник времени и пауз: подменяется в тестах, чтобы не ждать реально. */
export type MaxClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type MaxChannelState = {
  marker: number | null;
  lastEventAt: string | null;
};

/** Хранилище состояния канала: маркер и время последнего события. */
export type MaxChannelStateStore = {
  load: () => Promise<MaxChannelState>;
  save: (state: MaxChannelState) => Promise<void>;
};

export type MaxAdapterOptions = {
  /** Токен бота. В срезе — только из переменной окружения `MAX_BOT_TOKEN`. */
  token: string;
  /** Клиент Bot API. Без него создаётся боевой клиент из `token`. */
  client?: MaxClient;
  /** Порт ядра: `runAgent(input: NormalizedMessage): Promise<AgentOutcome>`. */
  runAgent: (input: NormalizedMessage) => Promise<AgentOutcome>;
  /** Порт режима тени. */
  shadowMode: () => Promise<boolean>;
  /**
   * Порт уведомления об эскалации.
   *
   * По ADR-0008 в обычном режиме адаптер отправляет только результат
   * `respond`: эскалация клиенту не отправляется. Нейтральное уведомление
   * «передал менеджеру» — это отдельная возможность режима эскалации
   * (ADR-0014, режим `notice`), поэтому она включается портом, а не
   * отправляется всегда.
   *
   * Без порта уведомление не отправляется: молчание безопаснее уведомления
   * о передаче вопроса менеджеру, которого в очереди может не быть.
   */
  notifiesEscalation?: () => boolean;
  /**
   * Порт записи в очередь менеджера для режима тени.
   *
   * Без порта результат в тени просто не отправляется: клиенту ответа нет,
   * но менеджеру нечего показать.
   */
  recordShadowDraft?: ShadowQueuePort;
  /** Отправка сообщения. По умолчанию — клиент Bot API. */
  sendMessage?: (chatId: string, text: string) => Promise<void>;
  /** Порт маскирования ПД ядра. */
  mask?: MaskPort;
  /** Порт восстановления меток ПД в ответе. */
  restore?: RestorePort;
  /**
   * Порт проверки исходящего текста на необработанные персональные данные.
   *
   * Проверяется восстановленный текст: клиент законно получает свои же
   * данные обратно, а любое новое персональное значение в ответе — утечка.
   * Ответ, не прошедший проверку, клиенту не отправляется.
   */
  checkOutgoing?: OutgoingCheckPort;
  /** Состояние канала между перезапусками (маркер, последнее событие). */
  state?: MaxChannelStateStore;
  logger?: MaxLogger;
  clock?: MaxClock;
};

/**
 * Сессия адаптера: состояние опроса и уже обработанные события.
 *
 * Сессия отделена от цикла опроса, чтобы обработку пачки событий можно было
 * проверять без реального времени.
 */
export type MaxSession = {
  options: MaxAdapterOptions;
  client: MaxClient;
  logger: MaxLogger;
  clock: MaxClock;
  /** Маркер последней обработанной пачки. */
  marker: number | null;
  /** Время последнего полученного события. */
  lastEventAt: string | null;
  /** Обработанные идентификаторы сообщений — защита от повторов. */
  seen: Set<string>;
  /** Время последних отправок по каждому чату — предел 2/с. */
  lastSentAt: Map<string, number[]>;
  /** Очередь отправки по каждому диалогу: ответы чата идут по порядку. */
  sendChains: Map<string, Promise<void>>;
  /** Идёт ли опрос. */
  running: boolean;
  /** Текст в журнал без токена бота. */
  log: (message: string) => string;
};

const defaultLogger: MaxLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const defaultClock: MaxClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let session: MaxSession | null = null;

/**
 * Ограничивает скорость отправки: не более 2 сообщений в секунду на диалог.
 *
 * Возвращает время ожидания перед следующей отправкой в этом чате.
 */
export function rateLimitDelay(
  sentAt: number[],
  now: number,
  limit = MESSAGES_PER_SECOND,
  windowMs = RATE_WINDOW_MS,
): number {
  const recent = sentAt.filter((at) => now - at < windowMs);
  if (recent.length < limit) {
    return 0;
  }
  const oldest = Math.min(...recent);
  return windowMs - (now - oldest);
}

/**
 * Создаёт сессию адаптера: состояние опроса, клиент и порты.
 *
 * Сессия не запускает опрос — для этого есть `startMaxAdapter`.
 */
export async function createMaxSession(options: MaxAdapterOptions): Promise<MaxSession> {
  const logger = options.logger ?? defaultLogger;
  const clock = options.clock ?? defaultClock;
  const client = options.client ?? createMaxClient(options.token);
  const stored = options.state ? await options.state.load() : null;

  return {
    options,
    client,
    logger,
    clock,
    marker: stored?.marker ?? null,
    lastEventAt: stored?.lastEventAt ?? null,
    seen: new Set<string>(),
    lastSentAt: new Map<string, number[]>(),
    sendChains: new Map<string, Promise<void>>(),
    running: false,
    log: (message: string) => redactToken(message, options.token),
  };
}

/**
 * Обрабатывает одно событие MAX.
 *
 * Возвращает идентификатор сообщения, дошедшего до ядра, или `null`, если
 * событие отброшено: пустое, неподходящее или повторное.
 */
export async function handleMaxUpdate(
  current: MaxSession,
  update: MaxUpdate,
): Promise<string | null> {
  const message = await normalizeMaxUpdate(update, { mask: current.options.mask });
  if (!message) {
    // Пустое или неподходящее событие отбрасывается и не роняет опрос.
    return null;
  }

  if (current.seen.has(message.messageId)) {
    // Повторное событие не создаёт второе обращение и второй ответ.
    return null;
  }
  remember(current.seen, message.messageId);

  // Режим тени снимается один раз в начале обработки события и действует на
  // неё целиком: переключение настройки посередине обработки не должно
  // менять её исход (docs/plans/06-shadow-mode.md, шаг 4).
  const shadowMode = await current.options.shadowMode();

  const outcome = await current.options.runAgent(message);

  if (shadowMode) {
    // Режим тени: клиенту не отправляется ничего, включая уведомление об
    // эскалации. Результат сохраняется в очереди менеджера.
    await recordShadowResult(current, message, outcome);
    return message.messageId;
  }

  if (outcome.outcome !== "respond") {
    // Клиент получает нейтральное уведомление о передаче вопроса менеджеру.
    // Формулировка без сроков и обязательств: неподтверждённое обещание
    // («ответим в течение часа») продукт не даёт, а тишина в чате выглядит
    // как поломка. Уведомление не содержит черновика и деталей эскалации.
    //
    // Уведомление — не ответ: по ADR-0008 в обычном режиме клиенту уходит
    // только результат `respond`. Само уведомление включается портом
    // `notifiesEscalation` (режим эскалации `notice` по ADR-0014).
    if (current.options.notifiesEscalation?.() ?? false) {
      await notifyEscalation(current, message, outcome.escalation.reason);
    }
    return message.messageId;
  }

  const chatId = message.externalChatId;
  if (!chatId) {
    return message.messageId;
  }

  let text = outcome.answer.text;
  if (current.options.restore) {
    text = await current.options.restore(text, message.conversationId);
  }

  // Исходящая проверка: ответ с необработанными персональными данными
  // клиенту не отправляется. Восстановленные значения клиента утечкой не
  // считаются — их проверяет сам порт по таблице соответствий диалога.
  if (current.options.checkOutgoing) {
    const allowed = await current.options.checkOutgoing(
      text,
      message.conversationId,
    );
    if (!allowed) {
      current.logger.warn(
        current.log(
          `MAX: ответ не прошёл проверку на персональные данные и не отправлен клиенту для сообщения ${message.messageId}`,
        ),
      );
      return message.messageId;
    }
  }

  await sendWithRateLimit(current, chatId, text);
  current.logger.info(
    current.log(`MAX: ответ отправлен в чат ${chatId} для сообщения ${message.messageId}`),
  );
  return message.messageId;
}

/**
 * Сохраняет результат ядра в очереди менеджера в режиме тени.
 *
 * Запись одна на один результат: иначе в очереди появился бы дубль, и
 * менеджер увидел бы один и тот же вопрос дважды.
 *
 * Причина эскалации не переписывается: наличие черновика в очереди не
 * превращает эскалацию в разрешение отправить ответ клиенту.
 */
async function recordShadowResult(
  current: MaxSession,
  message: NormalizedMessage,
  outcome: AgentOutcome,
): Promise<void> {
  const record = current.options.recordShadowDraft;
  if (!record) {
    current.logger.warn(
      current.log(
        `MAX: режим тени — очередь менеджера недоступна, результат для сообщения ${message.messageId} не сохранён`,
      ),
    );
    return;
  }

  const isEscalation = outcome.outcome === "escalate";
  const result = isEscalation
    ? outcome.escalation.draft ?? outcome.escalation.summary
    : outcome.answer.text;
  const summary = isEscalation
    ? outcome.escalation.summary
    : "Ответ подготовлен в режиме тени и не отправлен клиенту.";
  const reason = isEscalation ? outcome.escalation.reason : "shadow_mode";
  const sources = isEscalation
    ? []
    : outcome.answer.sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        title: source.title,
        location: source.location ?? null,
      }));

  await record({
    conversationId: message.conversationId,
    channel: "max",
    reason,
    summary,
    result,
    sources,
    traceRef: message.conversationId,
  });

  current.logger.info(
    current.log(
      `MAX: режим тени — ответ для сообщения ${message.messageId} не отправлен, результат в очереди менеджера`,
    ),
  );
}

/**
 * Обрабатывает пачку событий.
 *
 * Возвращает идентификаторы сообщений, дошедших до ядра.
 */
export async function handleMaxUpdates(
  current: MaxSession,
  updates: MaxUpdate[],
): Promise<string[]> {
  const handled: string[] = [];
  for (const update of updates) {
    const messageId = await handleMaxUpdate(current, update);
    if (messageId) {
      handled.push(messageId);
    }
  }
  return handled;
}

/**
 * Уведомление клиенту об эскалации.
 *
 * Формулировка безопасная: без сроков, без обещаний и без деталей
 * эскалации. Причина эскалации пишется только в лог и в трассу ядра.
 */
const ESCALATION_NOTICE =
  "Передал вопрос менеджеру, ответим в рабочее время.";

/**
 * Отправляет клиенту уведомление о передаче вопроса менеджеру.
 *
 * В режиме тени уведомление не отправляется: режим тени запрещает любые
 * сообщения клиенту. Проверка режима уже сделана в начале обработки
 * события, поэтому здесь её повторять не нужно: повторное чтение могло бы
 * увидеть уже изменённую настройку.
 *
 * Ошибка отправки не роняет опрос — вопрос уже передан менеджеру, клиент
 * увидит статус в веб-кабинете.
 */
async function notifyEscalation(
  current: MaxSession,
  message: NormalizedMessage,
  reason: string,
): Promise<void> {
  const chatId = message.externalChatId;
  if (!chatId) {
    return;
  }

  try {
    await sendWithRateLimit(current, chatId, ESCALATION_NOTICE);
    current.logger.info(
      current.log(
        `MAX: уведомление об эскалации отправлено в чат ${chatId} для сообщения ${message.messageId} (причина ${reason})`,
      ),
    );
  } catch (error) {
    current.logger.error(
      current.log(
        `MAX: уведомление об эскалации не отправлено: ${describeError(error).split("\n")[0]}`,
      ),
    );
  }
}

/**
 * Отправка с учётом предела 2 сообщения в секунду на диалог.
 *
 * Очередь отправки своя у каждого диалога: пауза одного чата не задерживает
 * ответы других чатов.
 */
async function sendWithRateLimit(
  current: MaxSession,
  chatId: string,
  text: string,
): Promise<void> {
  const send = current.options.sendMessage
    ? current.options.sendMessage
    : (id: string, body: string) => current.client.sendMessage(id, body);

  const run = async () => {
    const sentAt = current.lastSentAt.get(chatId) ?? [];
    const delay = rateLimitDelay(sentAt, current.clock.now());
    if (delay > 0) {
      await current.clock.sleep(delay);
    }
    const sentAtNow = current.lastSentAt.get(chatId) ?? [];
    sentAtNow.push(current.clock.now());
    // Старые отправки за окном лимита больше не учитываются.
    current.lastSentAt.set(
      chatId,
      sentAtNow.filter((at) => current.clock.now() - at < RATE_WINDOW_MS),
    );
    await send(chatId, text);
  };

  const previous = current.sendChains.get(chatId) ?? Promise.resolve();
  const next = previous.then(run, run);
  current.sendChains.set(
    chatId,
    next.catch(() => undefined),
  );
  await next;
}

function remember(seen: Set<string>, messageId: string): void {
  seen.add(messageId);
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next();
    if (!oldest.done) {
      seen.delete(oldest.value);
    }
  }
}

/**
 * Запускает адаптер MAX: опрос событий и обработка.
 */
export async function startMaxAdapter(options: MaxAdapterOptions): Promise<void> {
  if (session) {
    throw new Error("адаптер MAX уже запущен");
  }
  session = await createMaxSession(options);
  session.running = true;
  void pollLoop(session);
}

/**
 * Останавливает адаптер MAX.
 */
export async function stopMaxAdapter(): Promise<void> {
  if (!session) {
    return;
  }
  session.running = false;
  await Promise.all([...session.sendChains.values()].map((chain) => chain.catch(() => undefined)));
  session = null;
}

/**
 * Состояние подключения канала — для маршрута статуса.
 */
export async function getMaxStatus(): Promise<MaxStatus> {
  if (!session) {
    return { running: false, lastEventAt: null, lastMarker: null, shadowMode: false };
  }
  return {
    running: session.running,
    lastEventAt: session.lastEventAt,
    lastMarker: session.marker,
    shadowMode: await session.options.shadowMode(),
  };
}

async function pollLoop(current: MaxSession): Promise<void> {
  while (current.running) {
    try {
      const response = await current.client.getUpdates(current.marker, {
        limit: 20,
        timeout: 30,
      });

      for (const update of response.updates) {
        if (!current.running) {
          return;
        }
        current.lastEventAt = new Date(update.timestamp).toISOString();
        try {
          await handleMaxUpdate(current, update);
        } catch (error) {
          current.logger.error(
            current.log(`MAX: событие не обработано: ${describeError(error).split("\n")[0]}`),
          );
        }
      }

      // Маркер двигается только после обработки пачки: сбой не теряет события.
      current.marker = response.marker;

      if (current.options.state) {
        await current.options.state.save({
          marker: current.marker,
          lastEventAt: current.lastEventAt,
        });
      }
    } catch (error) {
      current.logger.error(
        current.log(
          `MAX: опрос прерван, перезапуск через 5 с: ${describeError(error).split("\n")[0]}`,
        ),
      );
      // Перезапуск с задержкой и без потери маркера.
      await current.clock.sleep(5000);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
