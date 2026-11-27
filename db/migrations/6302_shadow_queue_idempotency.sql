-- Up Migration
-- Идемпотентность записи очереди менеджера (аудит C17).
--
-- Запись очереди должна быть одна на один результат ядра: повторная
-- доставка хода раньше создавала вторую строку, и менеджер видел один и
-- тот же вопрос дважды.
--
-- Ключ записи: диалог + безопасная ссылка на трассу + признак тени +
-- отпечаток содержимого. Отпечаток нужен потому, что `trace_ref` — это
-- идентификатор диалога: без него одна запись на диалог схлопнула бы всю
-- очередь многоходовой переписки (черновик первого хода и эскалация
-- второго стали бы одной строкой).
--
-- Отпечаток считает одна функция: и индекс, и запрос чтения существующей
-- записи используют её, поэтому выражение не может разойтись.
--
-- Признак NULL и пустая строка в черновике различаются: `NULL` означает
-- «черновика нет», пустая строка — «черновик пустой».
CREATE OR REPLACE FUNCTION escalation_dedupe_key(
  reason text,
  summary text,
  result text,
  draft text,
  channel text,
  sources jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT md5(
    coalesce(reason, '') || chr(31) ||
    coalesce(summary, '') || chr(31) ||
    coalesce(result, '') || chr(31) ||
    (CASE WHEN draft IS NULL THEN 'N' ELSE 'A' END) || coalesce(draft, '') ||
    chr(31) || coalesce(channel, '') || chr(31) ||
    coalesce(sources, '[]'::jsonb)::text
  )
$$;

ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS dedupe_key text
  GENERATED ALWAYS AS (
    escalation_dedupe_key(reason, summary, result, draft, channel, sources)
  ) STORED;

-- Дубли, созданные повторной доставкой, удаляются: остаётся первая запись
-- результата, остальные копии менеджеру ничего не добавляли.
DELETE FROM escalations e
 USING escalations d
 WHERE e.conversation_id = d.conversation_id
   AND e.trace_ref = d.trace_ref
   AND e.is_shadow = d.is_shadow
   AND e.dedupe_key = d.dedupe_key
   AND (d.created_at, d.id) < (e.created_at, e.id);

CREATE UNIQUE INDEX IF NOT EXISTS escalations_queue_dedupe_idx
  ON escalations (conversation_id, trace_ref, is_shadow, dedupe_key);

-- Down Migration
DROP INDEX IF EXISTS escalations_queue_dedupe_idx;

ALTER TABLE escalations DROP COLUMN IF EXISTS dedupe_key;

DROP FUNCTION IF EXISTS escalation_dedupe_key(text, text, text, text, text, jsonb);
