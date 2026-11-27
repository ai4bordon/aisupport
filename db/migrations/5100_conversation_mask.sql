-- Up Migration
-- Таблица соответствий меток ПД (docs/data-model.md §3.21, R14).
--
-- Модель получает только метки вида ⟦PERSON_1⟧; исходные значения хранятся
-- здесь, отдельно от текстов сообщений, и никогда не покидают серверную
-- часть. Ключ — диалог и метка: одно и то же исходное значение в разных
-- диалогах получает независимые метки.
CREATE TABLE conversation_mask (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_mask_pkey PRIMARY KEY (conversation_id, label)
);

-- Down Migration
DROP TABLE conversation_mask;
