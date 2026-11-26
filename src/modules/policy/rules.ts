import { getPool } from "@/db/pool";

/**
 * Правила полномочий агента.
 *
 * Безопасное допущение по умолчанию (ASSUMPTION A2): неподтверждённые
 * условия обещать нельзя — их нужно эскалировать. Поэтому правило без
 * подтверждённого значения в базе даёт `escalate`.
 */

export type PolicyRequest = {
  /** Текст запроса клиента. */
  text: string;
  /** Ключ проверяемого правила, например `discount_request`. */
  ruleKey: string;
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
 * Проверка полномочий по правилам арендатора.
 *
 * Правило `allow` разрешает ответ, `escalate` — запрещает. Если правила с
 * подтверждённым значением нет, действует безопасное допущение: эскалация.
 */
export async function check(
  request: PolicyRequest,
  tenantId: string,
): Promise<PolicyDecision> {
  const pool = getPool();
  const result = await pool.query<{ action: string; note: string | null }>(
    `SELECT action, note
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
  if (!rule) {
    return {
      allowed: false,
      reason: `Подтверждённых правил для «${request.ruleKey}» нет — передаём менеджеру.`,
    };
  }

  if (rule.action === "allow") {
    return { allowed: true, reason: rule.note };
  }

  return {
    allowed: false,
    reason: rule.note ?? `Правило «${request.ruleKey}» запрещает ответ агента.`,
  };
}
