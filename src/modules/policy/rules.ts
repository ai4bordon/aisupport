import { getPool } from "@/db/pool";

/**
 * Правила полномочий агента (ADR-0019).
 *
 * Ответы заказчика от 27.11.2026 изменили прежнее допущение A2: скидка без
 * купона до 5% — решение агента, выше — эскалация. Наличие товара не является
 * условием для выдачи цены, КП и счёта: менеджер подтверждает фактическую
 * поставку.
 *
 * Правило `allow` разрешает ответ, `escalate` — запрещает. Порог в
 * `threshold` — проценты: скидка выше порога не разрешается, даже если
 * правило само по себе разрешающее.
 *
 * Встроенные значения по умолчанию применяются, когда у арендатора нет
 * своего правила: правило из базы перекрывает их, но отсутствие правила
 * не должно превращать каждый вопрос клиента в эскалацию — так работал
 * прежний код, и агент не отвечал ни на что, кроме как по базе знаний.
 */

export type PolicyRequest = {
  /** Текст запроса клиента. */
  text: string;
  /** Ключ проверяемого правила, например `discount_request`. */
  ruleKey: string;
  /**
   * Запрошенный процент скидки, если клиент назвал число.
   *
   * Число нужно, чтобы отличить «скидку до 5%» от «скидку 10%»: правило
   * разрешающее без порога пропустило бы и то, и другое.
   */
  percent: number | null;
};

export type PolicyDecision = {
  allowed: boolean;
  reason: string | null;
};

/**
 * Ключи правил, которые ядро проверяет перед ответом.
 *
 * Ключ выбирается по содержанию запроса: обещание скидки, неподтверждённая
 * отсрочка платежа, возврат и сроки — всё это уходит менеджеру.
 */
const REQUEST_RULES: Array<{ ruleKey: string; pattern: RegExp }> = [
  { ruleKey: "discount_request", pattern: /скидк|дисконт|процент\s+скидк|дешевле/i },
  { ruleKey: "postpay_request", pattern: /отсрочк|постоплат|оплат[аы]\s+после|в\s+долг|рассрочк/i },
  { ruleKey: "refund_request", pattern: /возврат|вернуть\s+деньг|демпферж/i },
  { ruleKey: "delivery_terms_request", pattern: /срок\s+поставк|когда\s+постав|отгрузк/i },
];

/** Правило, которое применимо к запросу, если сработал его шаблон. */
export function ruleKeyForRequest(text: string): string | null {
  for (const rule of REQUEST_RULES) {
    if (rule.pattern.test(text)) return rule.ruleKey;
  }
  return null;
}

/**
 * Процент скидки, названный клиентом.
 *
 * Число читается рядом со словом «скидка», «дисконт» или «процентов»:
 * «скидку 10%», «10 процентов скидки», «скидка 10 процентов». Без числа
 * процент не назван — решение остаётся за агентом в пределах порога.
 */
export function requestedPercent(text: string): number | null {
  const patterns = [
    /(?:скидк|дисконт)[^0-9]{0,20}(\d{1,3})\s*(?:%|процент|процента|процентов|процентных)/iu,
    /(\d{1,3})\s*(?:%|процент|процента|процентов|процентных)[^0-9]{0,20}(?:скидк|дисконт)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const percent = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(percent)) return percent;
  }
  return null;
}

/**
 * Встроенные правила по умолчанию.
 *
 * Порог скидки — 5%: столько агент решает сам, без купона и без проверки
 * менеджером. Отсрочка платежа и возврат всегда уходят менеджеру: это
 * коммерческие условия, которые прототип обещать не может.
 */
const DEFAULT_RULES: Record<
  string,
  { action: "allow" | "escalate"; threshold: number | null; note: string }
> = {
  discount_request: {
    action: "allow",
    threshold: 5,
    note: "Скидка без купона — до 5%, решение агента.",
  },
  postpay_request: {
    action: "escalate",
    threshold: null,
    note: "Отсрочка платежа — только менеджер.",
  },
  refund_request: {
    action: "escalate",
    threshold: null,
    note: "Возврат средств — только менеджер.",
  },
  delivery_terms_request: {
    action: "allow",
    threshold: null,
    note: "Срок поставки берётся из карточки позиции каталога.",
  },
};

/**
 * Проверка полномочий по правилам арендатора.
 *
 * Правило арендатора перекрывает встроенное: указанное в базе значение
 * действует, пока оно действует по сроку.
 */
export async function check(
  request: PolicyRequest,
  tenantId: string,
): Promise<PolicyDecision> {
  const pool = getPool();
  const result = await pool.query<{
    action: string;
    note: string | null;
    threshold: number | null;
  }>(
    `SELECT action, note, threshold
     FROM policy_rules
     WHERE tenant_id = $1
       AND rule_key = $2
       AND valid_from <= now()
       AND (valid_to IS NULL OR valid_to > now())
     ORDER BY valid_from DESC
     LIMIT 1`,
    [tenantId, request.ruleKey],
  );

  const rule = result.rows[0];
  const fallback = DEFAULT_RULES[request.ruleKey];
  const effective = rule
    ? { action: rule.action, threshold: rule.threshold, note: rule.note }
    : fallback;

  if (!effective) {
    return {
      allowed: false,
      reason: `Подтверждённых правил для «${request.ruleKey}» нет — передаём менеджеру.`,
    };
  }

  if (effective.action === "allow") {
    // Порог проверяется и для разрешающего правила: скидка 10% не
    // разрешена, даже если правило само по себе разрешающее.
    if (
      effective.threshold !== null &&
      request.percent !== null &&
      request.percent > effective.threshold
    ) {
      return {
        allowed: false,
        reason: `Запрошенная скидка ${request.percent}% выше полномочий агента (до ${effective.threshold}%) — передаём менеджеру.`,
      };
    }
    return { allowed: true, reason: effective.note };
  }

  return {
    allowed: false,
    reason: effective.note ?? `Правило «${request.ruleKey}» запрещает ответ агента.`,
  };
}
