-- Frontsmith office: источник событий журнала ai_dispatcher — записи и обращения, созданные
-- AI-диспетчером (Conversation Module) после подтверждения посетителем.
-- Таблица журнала пересобирается по процедуре SQLite с тем же содержимым; данные не удаляются.
-- Журнал не является родителем внешних ключей, поэтому FK не выключаются

CREATE TABLE activity_events_v5 (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('business', 'customer', 'vehicle', 'service', 'inquiry', 'work_order', 'order_item', 'appointment', 'task', 'database')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  source TEXT NOT NULL CHECK (source IN ('cli', 'import', 'seed', 'migration', 'panel', 'ai_dispatcher')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
) STRICT;

INSERT INTO activity_events_v5 SELECT id, occurred_at, entity_type, entity_id, action, actor, source, summary, details_json, is_demo FROM activity_events ORDER BY rowid;
DROP TABLE activity_events;
ALTER TABLE activity_events_v5 RENAME TO activity_events;

CREATE INDEX activity_events_entity_idx ON activity_events (entity_type, entity_id);
CREATE INDEX activity_events_occurred_idx ON activity_events (occurred_at);
CREATE UNIQUE INDEX activity_work_report_fingerprint_uidx
  ON activity_events (json_extract(details_json, '$.fingerprint'))
  WHERE action = 'work_report_registered';
