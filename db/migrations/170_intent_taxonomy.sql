-- Up Migration
CREATE TABLE intent_taxonomy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  code text NOT NULL,
  title text NOT NULL,
  description text NULL,
  requires_escalation boolean NOT NULL DEFAULT false,
  ask_before_answer boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX intent_taxonomy_tenant_code_idx
  ON intent_taxonomy (tenant_id, code);

-- Девять категорий из переписок службы поддержки заказчика.
INSERT INTO intent_taxonomy (tenant_id, code, title, description, requires_escalation, ask_before_answer, sort_order)
SELECT t.id, seed.code, seed.title, seed.description, seed.requires_escalation, seed.ask_before_answer, seed.sort_order
FROM tenants t
CROSS JOIN (
  VALUES
    ('price_of_product', 'Просто цена конкретного товара', 'Клиент просит цену одного названного товара.', false, false, 1),
    ('configuration', 'Конфигурация / спецификация', 'Клиент уточняет состав, версии и параметры лицензии.', false, true, 2),
    ('vendor_availability', 'Доступность вендора (можно ли купить)', 'Клиент спрашивает, можно ли купить у конкретного вендора.', false, false, 3),
    ('discounts', 'Скидки / льготы / спецусловия', 'Неподтверждённые скидки обещать нельзя — эскалация.', true, false, 4),
    ('individual_entrepreneur', 'Физлицо / самозанятый / срок', 'Условия для физлиц и самозанятых, сроки.', false, false, 5),
    ('other_purchase', 'Прочее (покупка)', 'Прочие вопросы о покупке.', false, false, 6),
    ('government_procurement', 'Госзакупки / процедуры', 'Вопросы по государственным закупкам.', true, true, 7),
    ('quote_document', 'Счет / КП как документ (с реквизитами)', 'Формирование КП или счёта с реквизитами.', false, true, 8),
    ('follow_up', 'Follow-up / не дозвонился', 'Клиент возвращается после неудачного контакта.', false, false, 9)
) AS seed(code, title, description, requires_escalation, ask_before_answer, sort_order)
WHERE t.slug = 'demo-tenant';

-- Down Migration
DROP TABLE intent_taxonomy;
