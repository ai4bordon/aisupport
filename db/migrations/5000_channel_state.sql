-- Up Migration
-- Состояние канала MAX: маркер опроса и время последнего события по диалогу.
--
-- Маркер сохраняется между перезапусками, чтобы перезапуск адаптера не терял
-- события: без маркера `GET /updates` вернул бы уже обработанные события
-- повторно.
--
-- Строка с `external_chat_id = ''` — состояние канала целиком (маркер опроса
-- и режим тени). Остальные строки — состояние отдельных диалогов.
CREATE TABLE channel_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  channel text NOT NULL,
  external_chat_id text NOT NULL DEFAULT '',
  marker bigint,
  last_event_at timestamptz,
  shadow_mode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, external_chat_id)
);

CREATE INDEX channel_state_last_event_at_idx
  ON channel_state (tenant_id, channel, last_event_at DESC);

-- Down Migration
DROP TABLE IF EXISTS channel_state;
