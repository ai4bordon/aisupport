-- Up Migration
-- Состояние подбора в диалоге (ADR-0015, R1a/R1b).
--
-- Собранные слоты (количество, срок лицензии, тип развёртывания, вендор)
-- живут в диалоге: уточняющий вопрос задаётся один раз за слот, и ответ
-- клиента на него дополняет уже собранное состояние, а не начинает с нуля.
--
-- Таблица намеренно отдельная от `messages`: состояние подбора — это
-- производная величина, а не сообщение, и оно не должно попадать в
-- историю переписки как реплика клиента.
--
-- Имена слотов. Список открыт: новый слот добавляется без правки
-- ограничения, иначе добавление слота требовало бы новой миграции на
-- уже применённой таблице.
CREATE TABLE conversation_slots (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slot text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_slots_pkey PRIMARY KEY (conversation_id, slot),
  CONSTRAINT conversation_slots_slot_check
    CHECK (slot <> '' AND length(slot) <= 64)
);

-- Down Migration
DROP TABLE conversation_slots;
